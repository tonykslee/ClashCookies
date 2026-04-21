const { spawnSync } = require("node:child_process");

function normalizeNodeOptions(input) {
  const tokens = String(input ?? "")
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !token.startsWith("--max-old-space-size="));
  tokens.push("--max-old-space-size=1024");
  return tokens.join(" ");
}

function main() {
  const env = {
    ...process.env,
    NODE_OPTIONS: normalizeNodeOptions(process.env.NODE_OPTIONS),
  };
  const tscPath = require.resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tscPath], {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

main();
