import { describe, expect, it, vi } from "vitest";
import {
  getCommandRegistrationConfigFromEnv,
  getDiscordRestTimeoutMsFromEnv,
  getStartupBootstrapRetryConfigFromEnv,
  getStartupLoginRetryConfigFromEnv,
  isTransientRegistrationError,
  registerGuildCommandsWithRetry,
  runWithTransientRetry,
} from "../src/services/StartupCommandRegistrationService";

describe("StartupCommandRegistrationService config", () => {
  it("uses deterministic defaults when env is missing or invalid", () => {
    expect(getCommandRegistrationConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      maxAttempts: 3,
      baseBackoffMs: 2000,
    });
    expect(
      getCommandRegistrationConfigFromEnv({
        STARTUP_REGISTER_GUILD_COMMANDS: "banana",
        STARTUP_COMMAND_REGISTRATION_MAX_ATTEMPTS: "-2",
        STARTUP_COMMAND_REGISTRATION_BASE_BACKOFF_MS: "abc",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      enabled: true,
      maxAttempts: 3,
      baseBackoffMs: 2000,
    });
    expect(getDiscordRestTimeoutMsFromEnv({} as NodeJS.ProcessEnv)).toBe(30000);
    expect(
      getDiscordRestTimeoutMsFromEnv({
        DISCORD_REST_TIMEOUT_MS: "xyz",
      } as NodeJS.ProcessEnv)
    ).toBe(30000);
    expect(getStartupLoginRetryConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      baseBackoffMs: 2000,
      maxBackoffMs: 60000,
    });
    expect(getStartupBootstrapRetryConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      baseBackoffMs: 2000,
      maxBackoffMs: 60000,
    });
  });

  it("parses valid env config values", () => {
    expect(
      getCommandRegistrationConfigFromEnv({
        STARTUP_REGISTER_GUILD_COMMANDS: "false",
        STARTUP_COMMAND_REGISTRATION_MAX_ATTEMPTS: "5",
        STARTUP_COMMAND_REGISTRATION_BASE_BACKOFF_MS: "1500",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      enabled: false,
      maxAttempts: 5,
      baseBackoffMs: 1500,
    });
    expect(
      getDiscordRestTimeoutMsFromEnv({
        DISCORD_REST_TIMEOUT_MS: "45000",
      } as NodeJS.ProcessEnv)
    ).toBe(45000);
    expect(
      getStartupLoginRetryConfigFromEnv({
        STARTUP_LOGIN_BASE_BACKOFF_MS: "1500",
        STARTUP_LOGIN_MAX_BACKOFF_MS: "45000",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      baseBackoffMs: 1500,
      maxBackoffMs: 45000,
    });
    expect(
      getStartupBootstrapRetryConfigFromEnv({
        STARTUP_BOOTSTRAP_BASE_BACKOFF_MS: "2500",
        STARTUP_BOOTSTRAP_MAX_BACKOFF_MS: "30000",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      baseBackoffMs: 2500,
      maxBackoffMs: 30000,
    });
  });
});

describe("StartupCommandRegistrationService retries", () => {
  it("skips registration when disabled", async () => {
    const setMock = vi.fn();
    const result = await registerGuildCommandsWithRetry({
      guild: { commands: { set: setMock } },
      commands: [{ name: "a" }],
      config: { enabled: false, maxAttempts: 3, baseBackoffMs: 2000 },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: vi.fn(),
    });

    expect(result).toEqual({ status: "skipped" });
    expect(setMock).not.toHaveBeenCalled();
  });

  it("retries transient failures and succeeds", async () => {
    const setMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Request aborted"), { code: "UND_ERR_ABORTED" }))
      .mockResolvedValueOnce(undefined);
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await registerGuildCommandsWithRetry({
      guild: { commands: { set: setMock } },
      commands: [{ name: "a" }],
      config: { enabled: true, maxAttempts: 3, baseBackoffMs: 2000 },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: sleepMock,
    });

    expect(result).toEqual({ status: "success", attempts: 2 });
    expect(setMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it("does not retry non-transient failures", async () => {
    const setMock = vi.fn().mockRejectedValueOnce(new Error("Invalid Form Body"));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await registerGuildCommandsWithRetry({
      guild: { commands: { set: setMock } },
      commands: [{ name: "a" }],
      config: { enabled: true, maxAttempts: 3, baseBackoffMs: 2000 },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: sleepMock,
    });

    expect(result.status).toBe("failed");
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("returns failed after max transient retries", async () => {
    const setMock = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Request aborted"), { code: "UND_ERR_ABORTED", name: "AbortError" })
      );
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await registerGuildCommandsWithRetry({
      guild: { commands: { set: setMock } },
      commands: [{ name: "a" }],
      config: { enabled: true, maxAttempts: 2, baseBackoffMs: 1000 },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: sleepMock,
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(setMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });
});

describe("StartupCommandRegistrationService transient classifier", () => {
  it("classifies abort/timeout signatures as transient", () => {
    expect(isTransientRegistrationError({ code: "UND_ERR_ABORTED" })).toBe(true);
    expect(isTransientRegistrationError({ name: "AbortError" })).toBe(true);
    expect(isTransientRegistrationError({ message: "Request aborted" })).toBe(true);
    expect(isTransientRegistrationError({ message: "Invalid Form Body" })).toBe(false);
  });
});

describe("StartupCommandRegistrationService shared retry helper", () => {
  it("retries transient failures and succeeds with capped backoff", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Request aborted"), { code: "UND_ERR_ABORTED" }))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const failures: Array<{ willRetry: boolean; backoffMs: number | null }> = [];

    const result = await runWithTransientRetry({
      execute,
      config: { baseBackoffMs: 2000, maxBackoffMs: 2500 },
      sleep,
      onFailure: (context) => {
        failures.push({ willRetry: context.willRetry, backoffMs: context.backoffMs });
      },
    });

    expect(result).toEqual({ status: "success", attempts: 2, value: "ok" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(failures).toEqual([{ willRetry: true, backoffMs: 2000 }]);
  });

  it("fails immediately on non-transient errors", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("TOKEN_INVALID"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runWithTransientRetry({
      execute,
      config: { baseBackoffMs: 1000, maxBackoffMs: 5000 },
      sleep,
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.transient).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors maxAttempts for transient failures", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Request aborted"), { code: "UND_ERR_ABORTED" }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runWithTransientRetry({
      execute,
      config: { baseBackoffMs: 1000, maxBackoffMs: 5000, maxAttempts: 2 },
      sleep,
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(result.transient).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
