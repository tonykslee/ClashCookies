"use strict";

// This helper is deliberately narrow: it accepts only the three bounded,
// selected-metadata streams collected by production-vm-discovery.sh and
// delegates identity decisions to the Phase 2B direct-Docker adapter.
const fs = require("node:fs");
const adapter = require("../direct-docker-adapter.js");

function section(input, name) {
  const begin = `${name}_BEGIN\n`;
  const end = `\n${name}_END`;
  const start = input.indexOf(begin);
  const finish = input.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0 || finish < start) throw new Error("runtime_contract_input_invalid");
  return input.slice(start + begin.length, finish).replace(/\r?\n$/, "");
}

function reject() {
  process.stdout.write("REJECT|phase2b_runtime_contract\n");
  process.exitCode = 3;
}

try {
  const input = fs.readFileSync(0, "utf8");
  const listing = adapter.parseRunningContainerListing(section(input, "LIST"));
  const inspected = adapter.parseDockerInspectListing(section(input, "INSPECT"));
  const processes = adapter.parseHostProcessListing(section(input, "PROCESS"));
  const snapshot = adapter.normalizeRuntimeEvidence(listing, inspected, processes);
  adapter.inspectRuntimeSnapshot(snapshot, { runtime: adapter.DEFAULT_RUNTIME });
  process.stdout.write("PASS|phase2b_runtime_contract\n");
} catch (error) {
  if (error && error.code === "runtime_ambiguity") {
    reject();
  } else if (error && error.code === "runtime_identity_invalid") {
    reject();
  } else {
    process.stdout.write("ERROR|phase2b_runtime_contract\n");
    process.exitCode = 2;
  }
}
