#!/usr/bin/env node

const { readFileSync, writeFileSync } = require("node:fs");
const { footprint } = require("./runtime-artifact-manifest.js");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) throw new Error(`unexpected argument: ${argv[index]}`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root || !args.embedded || !args.output || !args.sha256 || !args["archive-bytes"]) throw new Error("--root, --embedded, --output, --sha256 and --archive-bytes are required");
const manifest = JSON.parse(readFileSync(args.embedded, "utf8"));
manifest.integrity.sha256 = args.sha256;
manifest.measurements.archiveBytes = Number(args["archive-bytes"]);
manifest.measurements.extractedFootprintBytes = footprint(args.root);
manifest.artifact.archiveSha256 = args.sha256;
manifest.artifact.archiveBytes = Number(args["archive-bytes"]);
writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
