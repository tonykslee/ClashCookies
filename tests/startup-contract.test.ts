import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

type PackageJson = {
  scripts: Record<string, string>;
};

type CommandResult = ReturnType<typeof spawnSync>;

const repoRoot = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as PackageJson;
const scripts = packageJson.scripts;

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.exe" : "npm";
}

function runNpm(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): CommandResult {
  return spawnSync(npmExecutable(), args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "clashcookies-startup-contract-"));
}

function writePackage(tempProject: string, packageScripts: Record<string, string>): void {
  writeFileSync(
    join(tempProject, "package.json"),
    JSON.stringify({ private: true, scripts: packageScripts }, null, 2),
  );
}

function writePrismaShim(tempProject: string): void {
  const binDirectory = join(tempProject, "node_modules", ".bin");
  mkdirSync(binDirectory, { recursive: true });
  const shim = [
    'const fs = require("node:fs");',
    "const marker = process.env.PRISMA_MARKER;",
    "if (marker) fs.writeFileSync(marker, JSON.stringify(process.argv.slice(2)));",
    'process.exit(Number.parseInt(process.env.PRISMA_EXIT_CODE ?? "0", 10));',
    "",
  ].join("\n");
  writeFileSync(join(binDirectory, "prisma-shim.js"), shim);

  if (process.platform === "win32") {
    writeFileSync(
      join(binDirectory, "prisma.cmd"),
      '@echo off\r\nnode "%~dp0prisma-shim.js" %*\r\n',
    );
    return;
  }

  writeFileSync(
    join(binDirectory, "prisma"),
    `#!/usr/bin/env node\n${shim}`,
  );
  chmodSync(join(binDirectory, "prisma"), 0o755);
}

function removeTempProject(tempProject: string): void {
  rmSync(tempProject, { recursive: true, force: true });
}

describe("application startup and explicit migration contract", () => {
  it("keeps build and dependency startup behavior while separating migrations", () => {
    expect(scripts["migrate:deploy"]).toBe("prisma migrate deploy");
    expect(scripts.start).toBe("npm run build && npm run start:runtime");
    expect(scripts["start:runtime"]).toBe("node dist/ClashCookies.js");
    expect(scripts["start:runtime"]).not.toContain("prisma");
  });

  it("invokes Prisma exactly for the explicit migration command", () => {
    const tempProject = makeTempProject();
    const marker = join(tempProject, "prisma-args.json");
    try {
      writePackage(tempProject, { "migrate:deploy": scripts["migrate:deploy"] });
      writePrismaShim(tempProject);

      const result = runNpm(["run", "migrate:deploy"], tempProject, {
        PRISMA_MARKER: marker,
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([
        "migrate",
        "deploy",
      ]);
    } finally {
      removeTempProject(tempProject);
    }
  });

  it("propagates an explicit migration failure as nonzero", () => {
    const tempProject = makeTempProject();
    try {
      writePackage(tempProject, { "migrate:deploy": scripts["migrate:deploy"] });
      writePrismaShim(tempProject);

      const result = runNpm(["run", "migrate:deploy"], tempProject, {
        PRISMA_EXIT_CODE: "17",
      });

      expect(result.status).not.toBe(0);
    } finally {
      removeTempProject(tempProject);
    }
  });

  it("starts the runtime without invoking migrations", () => {
    const tempProject = makeTempProject();
    const runtimeMarker = join(tempProject, "runtime-started");
    const prismaMarker = join(tempProject, "prisma-invoked");
    try {
      writePackage(tempProject, { "start:runtime": scripts["start:runtime"] });
      writePrismaShim(tempProject);
      mkdirSync(join(tempProject, "dist"));
      writeFileSync(
        join(tempProject, "dist", "ClashCookies.js"),
        'require("node:fs").writeFileSync(process.env.RUNTIME_MARKER, "started");\n',
      );

      const result = runNpm(["run", "start:runtime"], tempProject, {
        PRISMA_MARKER: prismaMarker,
        RUNTIME_MARKER: runtimeMarker,
      });

      expect(result.status).toBe(0);
      expect(readFileSync(runtimeMarker, "utf8")).toBe("started");
      expect(() => readFileSync(prismaMarker, "utf8")).toThrow();
    } finally {
      removeTempProject(tempProject);
    }
  });

  it("propagates runtime startup failures", () => {
    const tempProject = makeTempProject();
    try {
      writePackage(tempProject, { "start:runtime": scripts["start:runtime"] });
      mkdirSync(join(tempProject, "dist"));
      writeFileSync(join(tempProject, "dist", "ClashCookies.js"), "process.exit(23);\n");

      const result = runNpm(["run", "start:runtime"], tempProject, {});

      expect(result.status).toBe(23);
    } finally {
      removeTempProject(tempProject);
    }
  });

  it("keeps deployment and container entry points on the revised contract", () => {
    const containerStart = readFileSync(
      join(repoRoot, "ops", "deploy", "container-start.sh"),
      "utf8",
    );
    const deployScript = readFileSync(
      join(repoRoot, "ops", "deploy", "deploy-prod.sh"),
      "utf8",
    );
    const setup = readFileSync(join(repoRoot, "docs", "setup.md"), "utf8");
    const deployment = readFileSync(join(repoRoot, "docs", "deployment.md"), "utf8");

    expect(containerStart).toContain("./ops/deploy/ensure-yarn-deps.sh");
    expect(containerStart).toContain("npm run start");
    expect(containerStart).not.toContain("prisma migrate deploy");
    expect(deployScript).toContain("migration_changes_detected_fail_closed");
    expect(deployScript).toContain("bash ./ops/deploy/container-start.sh");
    expect(setup).toContain("npm run migrate:deploy");
    expect(deployment).toContain("Migrations are not part of normal application startup.");
    expect(deployment).toContain("npm run migrate:deploy");
  });
});
