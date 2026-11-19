import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const diagnostic = join(process.cwd(), "docs", "diagnostics", "production-deployment-installation-readiness-2026-11-17.md");
const validator = require("../ops/deploy/discovery/gate1-prerequisite-validator.js") as typeof import("../ops/deploy/discovery/gate1-prerequisite-validator.js");

const approvedHashes = validator.APPROVED_ARTIFACT_SHA256;

function shellPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  return execFileSync(bash, ["-lc", "cygpath -u \"$GATE1_TEST_PATH\""], {
    env: { ...process.env, GATE1_TEST_PATH: filePath },
    encoding: "utf8",
  }).trim();
}

function documentedCommand(): { command: string; remoteScript: string } {
  const command = readFileSync(diagnostic, "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("ssh -T -l tilo"));
  if (!command) throw new Error("fixed SSH command not found");
  const marker = 'clash-vm "';
  const start = command.indexOf(marker);
  if (start < 0 || !command.endsWith('"')) throw new Error("fixed SSH command is not CMD-shaped");
  const encodedRemoteScript = command.slice(start + marker.length, -1);
  if (encodedRemoteScript.includes('^"')) throw new Error("remote quote uses unsafe CMD caret escaping");
  if (encodedRemoteScript.replaceAll('""', "").includes('"')) throw new Error("remote double quote is not CMD-doubled");
  return { command, remoteScript: encodedRemoteScript.replaceAll('""', '"') };
}

type FixtureOptions = {
  archive?: boolean;
  wrapper?: boolean;
  envCandidate?: boolean;
  worktreeCandidate?: boolean;
  archiveHashError?: boolean;
};

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-gate1-probe-"));
  const bin = join(root, "bin");
  const discoveryRoot = join(root, "discovery", "production-vm-discovery-1cb81528");
  const app = join(root, "app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(discoveryRoot, "ops", "deploy", "discovery"), { recursive: true });
  mkdirSync(app, { recursive: true });

  for (const artifact of [
    "ops/deploy/direct-docker-adapter.js",
    "ops/deploy/discovery/production-vm-discovery.sh",
    "ops/deploy/discovery/runtime-contract-validator.js",
  ]) {
    writeFileSync(join(discoveryRoot, ...artifact.split("/")), `${artifact}\n`);
  }
  if (options.archive !== false) writeFileSync(join(root, "discovery", "clashcookies-production-vm-discovery-1cb81528.tar"), "synthetic archive\n");

  execFileSync("git", ["init", "--quiet", app]);
  execFileSync("git", ["-C", app, "config", "user.email", "gate1-test@example.invalid"]);
  execFileSync("git", ["-C", app, "config", "user.name", "Gate 1 test"]);
  writeFileSync(join(app, "tracked.txt"), "tracked\n");
  writeFileSync(join(app, ".gitignore"), ".env\n");
  execFileSync("git", ["-C", app, "add", "tracked.txt", ".gitignore"]);
  execFileSync("git", ["-C", app, "commit", "--quiet", "-m", "fixture"]);

  if (options.wrapper !== false) writeExecutable(join(root, "deploy-prod.sh"), "#!/usr/bin/env bash\nexit 0\n");
  if (options.envCandidate) writeFileSync(join(app, ".env"), "synthetic=not-a-secret\n");
  if (options.worktreeCandidate) mkdirSync(join(root, "app-replacement"));

  writeExecutable(join(bin, "id"), `#!/usr/bin/env bash
case "$1" in
  -u) printf '1000\\n' ;;
  -g) printf '1000\\n' ;;
  -G) printf '1000 27 100 999\\n' ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(join(bin, "sha256sum"), `#!/usr/bin/env bash
if [ "$#" -gt 1 ]; then
  path="\${!#}"
  case "$path" in
    *clashcookies-production-vm-discovery-1cb81528.tar) hash="${options.archiveHashError ? "not-a-hash" : approvedHashes.archive}" ;;
    *direct-docker-adapter.js) hash="${approvedHashes.adapter}" ;;
    *production-vm-discovery.sh) hash="${approvedHashes.collector}" ;;
    *runtime-contract-validator.js) hash="${approvedHashes.validator}" ;;
    *) hash="${"d".repeat(64)}" ;;
  esac
  printf '%s  %s\\n' "$hash" "$path"
else
  printf '${"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}  -\\n'
fi
`);

  let remoteScript = documentedCommand().remoteScript;
  const rootPath = shellPath(root);
  remoteScript = remoteScript
    .replaceAll("/home/tilo/.clashcookies-discovery", `${rootPath}/discovery`)
    .replaceAll("/home/tilo/deploy-prod.sh", `${rootPath}/deploy-prod.sh`)
    .replaceAll("/home/tilo/apps/clashcookies-prod", `${rootPath}/app`)
    .replaceAll("/run/lock", `${rootPath}/run-lock`)
    .replaceAll("/etc/clashcookies", `${rootPath}/etc-clashcookies`)
    .replaceAll("/var/lib/clashcookies", `${rootPath}/var-lib-clashcookies`);

  const env = {
    ...process.env,
    PATH: `${shellPath(bin)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
    GATE1_TEST_BIN: shellPath(bin),
  };
  return { root, env, remoteScript: `export PATH="$GATE1_TEST_BIN:$PATH"; ${remoteScript}` };
}

function runProbe(options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  const result = spawnSync(bash, ["-c", fixture.remoteScript], {
    env: fixture.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 20_000,
  });
  return { ...fixture, result };
}

function createCmdTransport(options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  const capture = join(fixture.root, "fake-ssh-capture.json");
  const fakeSsh = join(fixture.root, "bin", "fake-ssh.cjs");
  const shellRoot = shellPath(fixture.root);
  const shellBin = shellPath(join(fixture.root, "bin"));
  const shellPathValue = `${shellBin}:/usr/bin:/bin:${process.env.PATH ?? ""}`;
  const fakeSshSource = String.raw`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const expected = ["-T", "-l", "tilo", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-o", "ForwardAgent=no", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1", "clash-vm"];
const args = process.argv.slice(2);
const remote = args.at(-1) ?? "";
const capturePath = process.env.FAKE_SSH_CAPTURE;
const record = { args, remote, execution_count: 1 };

if (fs.existsSync(capturePath)) {
  record.execution_count = 2;
  record.error = "DUPLICATE_FAKE_SSH_INVOCATION";
  fs.writeFileSync(capturePath, JSON.stringify(record));
  process.exit(91);
}
if (args.length !== expected.length + 1 || expected.some((value, index) => args[index] !== value)) {
  record.error = "UNEXPECTED_FAKE_SSH_ARGUMENTS";
  fs.writeFileSync(capturePath, JSON.stringify(record));
  process.exit(92);
}

const mapped = "export PATH=\"$GATE1_TEST_BIN:$PATH\"; " + remote
  .replaceAll("/home/tilo/.clashcookies-discovery", process.env.FAKE_SSH_DISCOVERY)
  .replaceAll("/home/tilo/deploy-prod.sh", process.env.FAKE_SSH_WRAPPER)
  .replaceAll("/home/tilo/apps/clashcookies-prod", process.env.FAKE_SSH_APP)
  .replaceAll("/run/lock", process.env.FAKE_SSH_RUN_LOCK)
  .replaceAll("/etc/clashcookies", process.env.FAKE_SSH_ETC)
  .replaceAll("/var/lib/clashcookies", process.env.FAKE_SSH_VAR_LIB);
const result = spawnSync(process.env.FAKE_SSH_BASH, ["-c", mapped], {
  env: { ...process.env, PATH: process.env.FAKE_SSH_BASH_PATH },
  encoding: "utf8",
  maxBuffer: 128 * 1024,
  timeout: 20_000,
});
record.mapped_remote = mapped;
record.exit_status = result.status;
record.signal = result.signal;
fs.writeFileSync(capturePath, JSON.stringify(record));
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 93);
`;
  writeFileSync(fakeSsh, fakeSshSource);
  // `%*` is the only batch handoff; the Node helper records the post-CMD argv
  // and remote string so the transport boundary is asserted, not assumed.
  writeFileSync(join(fixture.root, "bin", "ssh.cmd"), `@echo off\r\n"%FAKE_SSH_NODE%" "%~dp0fake-ssh.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const cmdEnv = {
    ...process.env,
    PATH: `${join(fixture.root, "bin")};${systemRoot}\\System32;${systemRoot}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    FAKE_SSH_NODE: process.execPath,
    FAKE_SSH_CAPTURE: capture,
    FAKE_SSH_BASH: bash,
    FAKE_SSH_BASH_PATH: shellPathValue,
    GATE1_TEST_BIN: shellBin,
    FAKE_SSH_DISCOVERY: `${shellRoot}/discovery`,
    FAKE_SSH_WRAPPER: `${shellRoot}/deploy-prod.sh`,
    FAKE_SSH_APP: `${shellRoot}/app`,
    FAKE_SSH_RUN_LOCK: `${shellRoot}/run-lock`,
    FAKE_SSH_ETC: `${shellRoot}/etc-clashcookies`,
    FAKE_SSH_VAR_LIB: `${shellRoot}/var-lib-clashcookies`,
  };
  return { ...fixture, capture, fakeSsh, fakeSshSource, cmdEnv };
}

function runCmdProbe(options: FixtureOptions = {}) {
  const fixture = createCmdTransport(options);
  const command = documentedCommand().command;
  const where = execFileSync("where.exe", ["ssh"], {
    env: fixture.cmdEnv,
    encoding: "utf8",
  }).trim().split(/\r?\n/)[0];
  expect(where.toLowerCase()).toBe(fixture.fakeSsh.toLowerCase().replace("fake-ssh.cjs", "ssh.cmd"));
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command], {
    env: fixture.cmdEnv,
    encoding: "utf8",
    windowsVerbatimArguments: true,
    maxBuffer: 128 * 1024,
    timeout: 20_000,
  });
  if (!existsSync(fixture.capture)) {
    throw new Error(`fake SSH was not invoked: status=${result.status} signal=${result.signal} error=${result.error?.message ?? ""} stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const capture = readFileSync(fixture.capture, "utf8");
  return { ...fixture, command, result, capture: JSON.parse(capture) as { args: string[]; remote: string; mapped_remote?: string; execution_count: number; exit_status?: number; error?: string } };
}

function envelope(stdout: string, exitStatus: number) {
  return {
    schema_version: validator.SCHEMA_VERSION,
    packet_version: validator.PACKET_VERSION,
    target: "clash-vm",
    account: "tilo",
    expected_artifact_sha256: { ...approvedHashes },
    capture: {
      ssh_exit_status: exitStatus,
      stream_status: "COMPLETE",
      eof_observed: true,
      stdout_sha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
      stdout_bytes: Buffer.byteLength(stdout, "utf8"),
    },
    provenance: {
      captured_at: "2026-11-18T01:02:03.000Z",
      host_key_binding: "EXTERNAL_REVIEW_REQUIRED",
      authorization_scope: "EXTERNAL_REVIEW_REQUIRED",
      source: "EXTERNAL_LOCAL_CAPTURE_WRAPPER",
    },
    stdout,
  };
}

describe("fixed Gate 1 prerequisite probe packet", () => {
  it("keeps the one-shot SSH controls and CMD escaping while using the repaired archive path", () => {
    const { command } = documentedCommand();
    expect(command).toMatch(/^ssh -T -l tilo -o BatchMode=yes -o RequestTTY=no -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 clash-vm /);
    expect(command).toContain("clashcookies-production-vm-discovery-1cb81528.tar");
    expect(command).not.toContain("/.clashcookies-discovery/production-vm-discovery-1cb81528.tar");
    expect(command).toContain('printf \'%s\\n\' ""$groups""');
    expect(command).toContain('printf \'%s|%s|sha256=%s\\n\' ""$label"" ""$meta"" ""$hash""');
    expect(command.length).toBeLessThan(8191);
  });

  it("runs the complete repaired command with regular-file metadata and validates its fixed output", () => {
    const { result, root } = runProbe({ envCandidate: true, worktreeCandidate: true });
    try {
      expect(result.status, `fixture stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("identity|uid=1000|gid=1000|group_count=4\n");
      expect(result.stdout).toContain("archive|regular file|");
      expect(result.stdout).toContain("wrapper|metadata=regular file|");
      expect(result.stdout).toContain("env_candidate|PRESENT|regular file|");
      expect(result.stdout).toContain("candidate_worktree|PRESENT|directory|");
      expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(20);
      const validation = validator.validateEnvelope(envelope(result.stdout, 0));
      expect(validation.status).toBe("VALID");
      expect(validation.reviewRequired).toBe(true);
      expect(validation.provenance).toBe("UNVERIFIED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves ABSENT classifications and validator UNKNOWN_OR_UNRESOLVED semantics", () => {
    const { result, root } = runProbe({ archive: false, wrapper: false });
    try {
      expect(result.status, `fixture stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("archive|ABSENT\n");
      expect(result.stdout).toContain("wrapper|MISSING\n");
      const validation = validator.validateEnvelope(envelope(result.stdout, 0));
      expect(validation.status).toBe("VALID");
      expect(validation.reason).toBe("UNKNOWN_OR_UNRESOLVED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a malformed artifact hash and does not continue to later probes", () => {
    const { result, root } = runProbe({ archiveHashError: true });
    try {
      expect(result.status, `fixture stderr=${result.stderr} stdout=${result.stdout}`).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^identity\|[^\n]+\nSTOP\|reason=HASH_INVALID\n$/);
      expect(result.stdout).not.toContain("adapter|");
      const validation = validator.validateEnvelope(envelope(result.stdout, 1));
      expect(validation.status).toBe("INCOMPLETE");
      expect(validation.reason).toBe("SSH_NONZERO_EXIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("fixed Gate 1 prerequisite probe through native Windows CMD", () => {
  it("forwards the unchanged command to an isolated fake SSH and validates synthetic output", () => {
    const { result, root, command, capture, fakeSshSource } = runCmdProbe({ envCandidate: true, worktreeCandidate: true });
    try {
      expect(result.status, `capture=${JSON.stringify(capture)} cmd stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(capture.execution_count).toBe(1);
      expect(capture.args).toHaveLength(17);
      expect(capture.remote).toBe(documentedCommand().remoteScript);
      expect(capture.remote).toContain("printf '%s\\n' \"$groups\"");
      expect(capture.remote).toContain("archive /home/tilo/.clashcookies-discovery/clashcookies-production-vm-discovery-1cb81528.tar");
      expect(capture.mapped_remote).toContain("env_candidate");
      expect(result.stdout, `capture=${JSON.stringify(capture)}`).toContain("identity|uid=1000|gid=1000|group_count=4\n");
      expect(result.stdout).toContain("env_candidate|PRESENT|regular file|");
      expect(result.stdout).toContain("candidate_worktree|PRESENT|directory|");
      expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(20);
      const validation = validator.validateEnvelope(envelope(result.stdout, 0));
      expect(validation.status).toBe("VALID");
      expect(validation.provenance).toBe("UNVERIFIED");
      expect(command).toBe(documentedCommand().command);
      expect(fakeSshSource).not.toMatch(/node:net|node:dgram|node:tls/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards malformed-hash failure and preserves fail-closed STOP behavior", () => {
    const { result, root, capture } = runCmdProbe({ archiveHashError: true });
    try {
      expect(result.status, `capture=${JSON.stringify(capture)} cmd stderr=${result.stderr} stdout=${result.stdout}`).toBe(1);
      expect(result.stderr).toBe("");
      expect(capture.execution_count).toBe(1);
      expect(capture.exit_status).toBe(1);
      expect(result.stdout).toMatch(/^identity\|[^\n]+\nSTOP\|reason=HASH_INVALID\n$/);
      expect(result.stdout).not.toContain("adapter|");
      const validation = validator.validateEnvelope(envelope(result.stdout, 1));
      expect(validation.status).toBe("INCOMPLETE");
      expect(validation.reason).toBe("SSH_NONZERO_EXIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
