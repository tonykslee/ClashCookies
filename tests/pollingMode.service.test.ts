import { describe, expect, it } from "vitest";
import {
  isActivePollingMode,
  isMirrorPollingMode,
  resolveDatabaseNameFromUrlForLog,
  resolveMirrorSyncIntervalMsFromEnv,
  resolvePollingMode,
  resolveRuntimeEnvironment,
} from "../src/services/PollingModeService";

describe("PollingModeService", () => {
  it("defaults to active mode and only enables mirror when explicitly configured", () => {
    expect(resolvePollingMode({} as NodeJS.ProcessEnv)).toBe("active");
    expect(resolvePollingMode({ POLLING_MODE: "mirror" } as NodeJS.ProcessEnv)).toBe(
      "mirror",
    );
    expect(resolvePollingMode({ POLLING_MODE: "unexpected" } as NodeJS.ProcessEnv)).toBe(
      "active",
    );
    expect(isActivePollingMode({ POLLING_MODE: "active" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
    expect(isMirrorPollingMode({ POLLING_MODE: "mirror" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  it("resolves mirror sync interval with sane defaults and minimum clamp", () => {
    expect(resolveMirrorSyncIntervalMsFromEnv({} as NodeJS.ProcessEnv)).toBe(
      15 * 60 * 1000,
    );
    expect(
      resolveMirrorSyncIntervalMsFromEnv({
        MIRROR_SYNC_INTERVAL_MINUTES: "30",
      } as NodeJS.ProcessEnv),
    ).toBe(30 * 60 * 1000);
    expect(
      resolveMirrorSyncIntervalMsFromEnv({
        MIRROR_SYNC_INTERVAL_MINUTES: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(60 * 1000);
  });

  it("normalizes runtime environment labels and database names for safety checks/logs", () => {
    expect(
      resolveRuntimeEnvironment({ POLLING_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe("prod");
    expect(
      resolveRuntimeEnvironment({ DEPLOY_ENV: "staging" } as NodeJS.ProcessEnv),
    ).toBe("staging");
    expect(resolveRuntimeEnvironment({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(
      "dev",
    );
    expect(resolveRuntimeEnvironment({} as NodeJS.ProcessEnv)).toBe("unknown");

    expect(
      resolveDatabaseNameFromUrlForLog(
        "postgresql://user:pass@127.0.0.1:5432/clashcookies_staging?schema=public",
      ),
    ).toBe("clashcookies_staging");
    expect(resolveDatabaseNameFromUrlForLog("not-a-url")).toBe("unknown");
  });
});

