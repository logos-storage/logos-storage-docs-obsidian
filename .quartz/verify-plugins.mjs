import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const quartzCheckout = process.env.QUARTZ_CHECKOUT ?? fileURLToPath(new URL("../quartz", import.meta.url))
const lockfile = JSON.parse(fs.readFileSync(new URL("./quartz.lock.json", import.meta.url), "utf8"))
const failures = []

// Quartz can exit successfully after failed installs. Check every locked plugin
// after the Shiki repair, before patching or building with an incomplete install.
for (const [name, entry] of Object.entries(lockfile.plugins)) {
  const pluginDir = path.join(quartzCheckout, ".quartz/plugins", name)
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: pluginDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (commit !== entry.commit) {
      throw new Error(`expected commit ${entry.commit}, found ${commit}`)
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))
    if (!pkg.main || !fs.statSync(path.join(pluginDir, pkg.main)).isFile()) {
      throw new Error("missing built plugin entry point")
    }
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(`Quartz plugin verification failed:\n${failures.join("\n")}`)
  process.exit(1)
}

console.log(`Verified ${Object.keys(lockfile.plugins).length} pinned Quartz plugins and their built entry points`)
