import { describe, expect, it, vi } from "vitest";
import {
  createHealthcheckHandler,
  evaluateReadiness,
  resolveHealthcheckConfigFromEnv,
} from "../src/services/HealthcheckServer";

describe("resolveHealthcheckConfigFromEnv", () => {
  it("uses safe defaults when env is unset", () => {
    expect(resolveHealthcheckConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      host: "0.0.0.0",
      livePath: "/livez",
      port: 8080,
      readyPath: "/healthz",
    });
  });

  it("normalizes boolean, port, and path overrides", () => {
    expect(
      resolveHealthcheckConfigFromEnv({
        HEALTHCHECK_ENABLED: "false",
        HEALTHCHECK_HOST: "127.0.0.1",
        HEALTHCHECK_LIVE_PATH: "live",
        HEALTHCHECK_PORT: "9090",
        HEALTHCHECK_READY_PATH: "ready",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      enabled: false,
      host: "127.0.0.1",
      livePath: "/live",
      port: 9090,
      readyPath: "/ready",
    });
  });
});

describe("evaluateReadiness", () => {
  it("returns ok when Discord is ready and the database probe succeeds", async () => {
    await expect(
      evaluateReadiness({
        checkDatabase: async () => undefined,
        isDiscordReady: () => true,
        now: () => new Date("2026-04-01T00:00:00.000Z"),
      })
    ).resolves.toEqual({
      checks: {
        database: "ok",
        discord: "ok",
      },
      service: "clashcookies",
      status: "ok",
      timestamp: "2026-04-01T00:00:00.000Z",
    });
  });

  it("skips the database probe when Discord is not ready", async () => {
    const checkDatabase = vi.fn(async () => undefined);
    await expect(
      evaluateReadiness({
        checkDatabase,
        isDiscordReady: () => false,
        now: () => new Date("2026-04-01T00:00:00.000Z"),
      })
    ).resolves.toEqual({
      checks: {
        database: "skipped",
        discord: "not_ready",
      },
      service: "clashcookies",
      status: "error",
      timestamp: "2026-04-01T00:00:00.000Z",
    });
    expect(checkDatabase).not.toHaveBeenCalled();
  });
});

describe("createHealthcheckHandler", () => {
  it("responds with 503 on readiness failures", async () => {
    const response = {
      end: vi.fn(),
      headersSent: false,
      setHeader: vi.fn(),
      statusCode: 0,
    };
    const handler = createHealthcheckHandler({
      checkDatabase: async () => {
        throw new Error("db down");
      },
      isDiscordReady: () => true,
      now: () => new Date("2026-04-01T00:00:00.000Z"),
    });

    await handler(
      {
        method: "GET",
        url: "/healthz",
      } as never,
      response as never
    );

    expect(response.statusCode).toBe(503);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json; charset=utf-8"
    );
    expect(response.end).toHaveBeenCalledWith(
      "{\"checks\":{\"database\":\"error\",\"discord\":\"ok\"},\"service\":\"clashcookies\",\"status\":\"error\",\"timestamp\":\"2026-04-01T00:00:00.000Z\"}\n"
    );
  });
});
