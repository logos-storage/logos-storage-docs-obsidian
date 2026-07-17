import fs from "node:fs"
import path from "node:path"

const defaultCheckout = new URL("../quartz", import.meta.url).pathname
const quartzCheckout = process.env.QUARTZ_CHECKOUT ?? defaultCheckout
const filePath = path.join(quartzCheckout, ".quartz/plugins/crawl-links/dist/index.js")

let source = fs.readFileSync(filePath, "utf8")

if (source.includes('node.tagName === "object" && node.properties && typeof node.properties.data === "string"')) {
  console.log("crawl-links object[data] patch already applied")
  process.exit(0)
}

const target = `              if (["img", "video", "audio", "iframe"].includes(node.tagName) && node.properties && typeof node.properties.src === "string") {
                if (opts.lazyLoad) {
                  node.properties.loading = "lazy";
                }
                if (!isAbsoluteUrlWithOptions(node.properties.src)) {
                  let dest = node.properties.src;
                  dest = node.properties.src = transformLink(fileSlug, dest, transformOptions);
                  node.properties.src = dest;
                }
              }`

const replacement = `${target}
              if (node.tagName === "object" && node.properties && typeof node.properties.data === "string") {
                if (!isAbsoluteUrlWithOptions(node.properties.data)) {
                  let dest = node.properties.data;
                  dest = node.properties.data = transformLink(fileSlug, dest, transformOptions);
                  node.properties.data = dest;
                }
              }`

if (!source.includes(target)) {
  throw new Error(`Could not find crawl-links resource rewrite block in ${filePath}`)
}

source = source.replace(target, replacement)
fs.writeFileSync(filePath, source)
console.log("Patched crawl-links to resolve object[data] asset URLs")
