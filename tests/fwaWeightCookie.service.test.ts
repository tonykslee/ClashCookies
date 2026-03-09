import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FwaStatsWeightCookieService } from "../src/services/FwaStatsWeightCookieService";

type SettingsMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function createSettingsMock(): SettingsMock {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("FwaStatsWeightCookieService", () => {
  const originalCookie = process.env.FWASTATS_WEIGHT_COOKIE;

  beforeEach(() => {
    delete process.env.FWASTATS_WEIGHT_COOKIE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (typeof originalCookie === "string") {
      process.env.FWASTATS_WEIGHT_COOKIE = originalCookie;
    } else {
      delete process.env.FWASTATS_WEIGHT_COOKIE;
    }
  });

  it("stores both cookie pairs via SettingsService and returns secret-safe metadata", async () => {
    const settings = createSettingsMock();
    const service = new FwaStatsWeightCookieService(settings as any);

    const result = await service.setCookies({
      applicationCookieRaw:
        ".AspNetCore.Identity.Application=app-secret; Expires=Wed, 10 Mar 2027 00:00:00 GMT",
      antiforgeryCookieRaw: ".AspNetCore.Antiforgery.abc=anti-secret",
      guildId: "guild-1",
      userId: "user-1",
    });

    expect(result.applicationCookieName).toBe(".AspNetCore.Identity.Application");
    expect(result.antiforgeryCookieName).toBe(".AspNetCore.Antiforgery.abc");
    expect(result.applicationCookieExpiresAt).toBeInstanceOf(Date);
    expect(settings.set).toHaveBeenCalledTimes(1);
    const savedPayload = String(settings.set.mock.calls[0]?.[1] ?? "");
    expect(savedPayload).toContain("\"applicationCookie\"");
    expect(result.applicationCookieName).not.toContain("app-secret");
    expect(result.antiforgeryCookieName).not.toContain("anti-secret");
  });

  it("returns settings cookie header context when stored cookie pairs exist", async () => {
    const settings = createSettingsMock();
    const service = new FwaStatsWeightCookieService(settings as any);
    await service.setCookies({
      applicationCookieRaw: ".AspNetCore.Identity.Application=app-secret",
      antiforgeryCookieRaw: ".AspNetCore.Antiforgery.abc=anti-secret",
      guildId: "guild-1",
      userId: "user-1",
    });
    process.env.FWASTATS_WEIGHT_COOKIE = "env-cookie=ignored";

    const context = await service.getCookieHeaderContext();

    expect(context.source).toBe("settings");
    expect(context.cookieHeader).toContain(".AspNetCore.Identity.Application=app-secret");
    expect(context.cookieHeader).toContain(".AspNetCore.Antiforgery.abc=anti-secret");
  });

  it("falls back to env cookie header when no stored cookie config exists", async () => {
    process.env.FWASTATS_WEIGHT_COOKIE = "session=from-env";
    const settings = createSettingsMock();
    const service = new FwaStatsWeightCookieService(settings as any);

    const context = await service.getCookieHeaderContext();

    expect(context.source).toBe("env");
    expect(context.cookieHeader).toBe("session=from-env");
  });

  it("returns status summary with expiration unknown fallback", async () => {
    const settings = createSettingsMock();
    const service = new FwaStatsWeightCookieService(settings as any);
    await service.setCookies({
      applicationCookieRaw: ".AspNetCore.Identity.Application=app-secret",
      antiforgeryCookieRaw: ".AspNetCore.Antiforgery.abc=anti-secret",
      guildId: "guild-1",
      userId: "user-1",
    });

    const status = await service.getCookieStatus();

    expect(status.applicationCookiePresent).toBe(true);
    expect(status.antiforgeryCookiePresent).toBe(true);
    expect(status.applicationCookieExpiresAt).toBeNull();
    expect(status.updatedAt).toBeInstanceOf(Date);
    expect(status.runtimeCookieSource).toBe("settings");
  });

  it("returns missing status when no stored or env cookies exist", async () => {
    const settings = createSettingsMock();
    const service = new FwaStatsWeightCookieService(settings as any);

    const status = await service.getCookieStatus();
    const context = await service.getCookieHeaderContext();

    expect(status.applicationCookiePresent).toBe(false);
    expect(status.antiforgeryCookiePresent).toBe(false);
    expect(status.runtimeCookieSource).toBe("none");
    expect(context.source).toBe("none");
    expect(context.cookieHeader).toBeNull();
  });

  it("rejects malformed cookie input safely", async () => {
    const settings = createSettingsMock();
    const service = new FwaStatsWeightCookieService(settings as any);

    await expect(
      service.setCookies({
        applicationCookieRaw: "not-a-cookie",
        antiforgeryCookieRaw: ".AspNetCore.Antiforgery.abc=anti-secret",
        guildId: "guild-1",
        userId: "user-1",
      })
    ).rejects.toThrow("Application cookie invalid");
    expect(settings.set).not.toHaveBeenCalled();
  });
});
