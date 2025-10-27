A summary of running different test scenarios with `gotestsum` based on an example 

## gotestsum Command Patterns

### 1. **Only Selected Test**
```bash
# Run a specific test function
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "TestCodexArchiveDownloader_BasicSingleArchive$" -count 1

# Run specific testify test
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "TestCodexArchiveDownloader_BasicSingleArchive_Testify$" -count 1

# Run multiple archives testify test
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "TestCodexArchiveDownloader_MultipleArchives_Testify$" -count 1
```

### 2. **Only Selected Test Suite**
```bash
# Run the entire testify suite (all methods in the suite)
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "TestCodexArchiveDownloaderSuite" -count 1

# Run a specific test method within the suite
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "TestCodexArchiveDownloaderSuite/TestBasicSingleArchive" -count 1
```

### 3. **All Tests for Given Package**
```bash
# Run all tests in communities package
gotestsum --packages="./communities" -f testname --rerun-fails -- -count 1

# Alternative syntax (same result)
gotestsum --packages="./communities" -f testname --rerun-fails

# Run all tests with verbose output
gotestsum --packages="./communities" -f testname --rerun-fails -- -v -count 1
```

### 4. **Integration Tests**
```bash
# Run only integration tests (using build tags)
gotestsum --packages="./communities" -f testname --rerun-fails -- -tags=integration -run "Integration" -count 1

# Run integration tests with timeout (since they may take longer)
gotestsum --packages="./communities" -f testname --rerun-fails -- -tags=integration -run "Integration" -timeout=60s -count 1

# Run integration tests with specific environment variables
CODEX_HOST=localhost CODEX_API_PORT=8080 gotestsum --packages="./communities" -f testname --rerun-fails -- -tags=integration -run "Integration" -count 1
```

## Advanced gotestsum Patterns

### **Filter by Pattern (Multiple Tests)**
```bash
# Run all archive downloader tests (both standard and testify)
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "ArchiveDownloader" -count 1

# Run only testify tests
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "Testify" -count 1

# Run all CodexClient tests
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "CodexClient" -count 1
```

### **Output Formats**
```bash
# Different output formats
gotestsum --packages="./communities" -f dots         # Dots progress
gotestsum --packages="./communities" -f pkgname      # Show package names
gotestsum --packages="./communities" -f testname     # Show test names (recommended)
gotestsum --packages="./communities" -f standard-quiet  # Minimal output
```

### **Multiple Packages**
```bash
# Run tests across multiple packages
gotestsum --packages="./communities,./cmd/upload,./cmd/download" -f testname --rerun-fails -- -count 1

# Run all packages recursively
gotestsum --packages="./..." -f testname --rerun-fails -- -count 1
```

### **Race Detection and Coverage**
```bash
# Run with race detection
gotestsum --packages="./communities" -f testname --rerun-fails -- -race -count 1

# Run with coverage
gotestsum --packages="./communities" -f testname --rerun-fails -- -cover -count 1

# Run with both race detection and coverage
gotestsum --packages="./communities" -f testname --rerun-fails -- -race -cover -count 1
```

## Key gotestsum Advantages

1. **Better Output Formatting**: Clean, colored output with test names
2. **Automatic Retry**: `--rerun-fails` reruns failed tests automatically
3. **JUnit XML Output**: `--junitfile=results.xml` for CI/CD integration
4. **JSON Output**: `--jsonfile=results.json` for parsing
5. **Watch Mode**: `--watch` to rerun tests on file changes
6. **Parallel Execution**: Better handling of parallel test output

## Complete Examples for Your Project

```bash
# Quick test of archive downloader functionality
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "ArchiveDownloader" -count 1

# Full test suite with coverage
gotestsum --packages="./communities" -f testname --rerun-fails -- -cover -count 1

# Integration tests (when you have a Codex node running)
gotestsum --packages="./communities" -f testname --rerun-fails -- -tags=integration -timeout=60s -count 1

# Development workflow with watch mode
gotestsum --packages="./communities" -f testname --watch -- -count 1
```

The key difference from `go test` is that `gotestsum` provides much better visual feedback, automatic retry capabilities, and better CI/CD integration options while using the same underlying Go test infrastructure.

## Logs

In your tests you can include custom logs.

`go test -v` prints them without an issue, but for `gotestsum` to do the same you have to use `standard-verbose` format option:

```bash
gotestsum --packages="./communities" -f standard-verbose --rerun-fails -- -run "TestCodexArchiveDownloaderSuite" -v -count 1
=== RUN   TestCodexArchiveDownloaderSuite
=== RUN   TestCodexArchiveDownloaderSuite/TestBasicSingleArchive
    codex_archive_downloader_testify_test.go:112: ✅ Basic single archive download test passed (testify version)
    codex_archive_downloader_testify_test.go:113:    - All mock expectations satisfied
    codex_archive_downloader_testify_test.go:114:    - Callback invoked: true
=== RUN   TestCodexArchiveDownloaderSuite/TestMultipleArchives
    codex_archive_downloader_testify_test.go:190: ✅ Multiple archives test passed (suite version)
    codex_archive_downloader_testify_test.go:191:    - Completed 3 out of 3 archives
--- PASS: TestCodexArchiveDownloaderSuite (0.20s)
    --- PASS: TestCodexArchiveDownloaderSuite/TestBasicSingleArchive (0.10s)
    --- PASS: TestCodexArchiveDownloaderSuite/TestMultipleArchives (0.10s)
PASS
ok      go-codex-client/communities     0.205s

DONE 3 tests in 0.205s
```

Compare this output with `-f testname`:

```bash
gotestsum --packages="./communities" -f testname --rerun-fails -- -run "TestCodexArchiveDownloaderSuite" -count 1
PASS communities.TestCodexArchiveDownloaderSuite/TestBasicSingleArchive (0.10s)
PASS communities.TestCodexArchiveDownloaderSuite/TestMultipleArchives (0.10s)
PASS communities.TestCodexArchiveDownloaderSuite (0.20s)
PASS communities

DONE 3 tests in 0.205s
```

> Notice that the test suite itself is also counted as a test - this is one we see `DONE 3 tests` instead of `DONE 2 tests`.