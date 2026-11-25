import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import path from "node:path";

describe("UserActivityReminderSchedulerService process boundary", () => {
  it(
    "survives strict unhandled-rejection mode and recovers after transient Prisma failures",
    async () => {
      const script = [
        "const { prisma } = require('./src/prisma');",
        "const { UserActivityReminderSchedulerService } = require('./src/services/remindme/UserActivityReminderSchedulerService');",
        "let calls = 0;",
        "prisma.userActivityReminderRule.findMany = async () => { calls += 1; if (calls <= 2) { const error = new Error('connection pool timeout'); error.code = 'P2024'; throw error; } return []; };",
        "const statusService = { markStarted: async () => ({}), markSucceeded: async () => ({}), markFailed: async () => ({}), markSkipped: async () => ({}) };",
        "const scheduler = new UserActivityReminderSchedulerService({}, {}, undefined, 10, statusService);",
        "scheduler.start();",
        "setTimeout(() => { scheduler.stop(); if (calls >= 3) { process.stdout.write('RECOVERED'); process.exit(0); } process.stderr.write('DID_NOT_RECOVER'); process.exit(1); }, 150);",
      ].join("\n");
      const child = spawn(
        process.execPath,
        [
          "--unhandled-rejections=strict",
          "--require",
          require.resolve("ts-node/register/transpile-only"),
          "--eval",
          script,
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          env: { ...process.env, NODE_ENV: "test" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          let stdout = "";
          let stderr = "";
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`scheduler process regression timed out stdout=${stdout} stderr=${stderr}`));
          }, 5_000);
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timeout);
            resolve({ code, stdout, stderr });
          });
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("RECOVERED");
      expect(result.stderr).not.toContain("UnhandledPromiseRejection");
    },
    10_000,
  );
});
