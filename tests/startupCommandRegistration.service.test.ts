import { describe, expect, it, vi } from "vitest";
import {
  getCommandRegistrationConfigFromEnv,
  getDiscordRestTimeoutMsFromEnv,
  isTransientRegistrationError,
  registerGuildCommandsWithRetry,
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
