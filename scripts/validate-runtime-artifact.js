#!/usr/bin/env node

const { validateAndExtract } = require("./runtime-artifact.js");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) throw new Error(`unexpected argument: ${argv[index]}`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!options.archive) throw new Error("--archive is required");
  const result = validateAndExtract({
    archivePath: options.archive,
    checksumPath: options.checksum || `${options.archive}.sha256`,
    manifestPath: options.manifest || `${options.archive}.manifest.json`,
    expectedSha: options["expected-sha"],
    expectedPlatform: options.platform || "linux/amd64",
    extractPath: options.extract,
  });
  console.log(JSON.stringify({ archive: result.archivePath, sha256: result.digest, entries: result.entries.length, sourceSha: result.manifest.source.gitSha }, null, 2));
} catch (error) {
  console.error(`[runtime-artifact] validation failed: ${error.message}`);
  process.exit(1);
}
