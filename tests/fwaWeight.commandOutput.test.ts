import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findFirst: vi.fn(),
  },
  apiUsage: {
    upsert: vi.fn(() => Promise.resolve(undefined)),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

import { Fwa } from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";
import { FwaStatsWeightService } from "../src/services/FwaStatsWeightService";
import { FwaStatsWeightCookieService } from "../src/services/FwaStatsWeightCookieService";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

function makeInteraction(params: {
  subcommand: "weight-age" | "weight-health" | "weight-cookie";
  tag: string | null;
  visibility?: "private" | "public";
  guildId?: string;
  applicationCookie?: string | null;
  antiforgeryCookie?: string | null;
  antiforgeryCookieName?: string | null;
  isAdmin?: boolean;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const isAdmin = params.isAdmin ?? true;
  const interaction = {
    guildId: params.guildId ?? "guild-1",
    user: { id: "user-1" },
    memberPermissions: {
      has: vi.fn(() => isAdmin),
    },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => params.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag;
        if (name === "visibility") return params.visibility ?? "private";
        if (name === "application-cookie") return params.applicationCookie ?? null;
        if (name === "antiforgery-cookie") return params.antiforgeryCookie ?? null;
        if (name === "antiforgery-cookie-name") return params.antiforgeryCookieName ?? null;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/fwa weight command output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(PointsSyncService.prototype, "findLatestSyncNum").mockResolvedValue(null);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.clanWarHistory.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders auth-failure messaging for /fwa weight-age and keeps normal rows", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      name: "Alpha",
    });
    vi.spyOn(FwaStatsWeightService.prototype, "getWeightAges").mockResolvedValue([
      {
        clanTag: "#ABC123",
        sourceUrl: "https://fwastats.com/Clan/ABC123/Weight",
        ageText: null,
        ageDays: null,
        scrapedAt: new Date("2026-03-09T00:00:00.000Z"),
        status: "login_required_cookie_rejected",
        httpStatus: 200,
        fromCache: false,
        error: "rejected cookie",
        authErrorCode: "FWASTATS_AUTH_EXPIRED",
      },
    ]);

    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-age",
      tag: "ABC123",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const payload = editReply.mock.calls[0]?.[0];
    const content = String(payload?.content ?? "");
    expect(content).toContain("unavailable (auth cookie rejected/expired)");
    expect(content).toContain("Recovery steps:");
    expect(content).toContain("/fwa weight-cookie");
    expect(content).toContain("https://i.imgur.com/HFzGNQD.png");
  });

  it("renders /fwa weight-health rows with auth note and healthy row", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha" },
      { tag: "#BBB222", name: "Bravo" },
    ]);
    vi.spyOn(FwaStatsWeightService.prototype, "getWeightAges").mockResolvedValue([
      {
        clanTag: "#AAA111",
        sourceUrl: "https://fwastats.com/Clan/AAA111/Weight",
        ageText: "2d ago",
        ageDays: 2,
        scrapedAt: new Date("2026-03-09T00:00:00.000Z"),
        status: "ok",
        httpStatus: 200,
        fromCache: false,
        error: null,
        authErrorCode: null,
      },
      {
        clanTag: "#BBB222",
        sourceUrl: "https://fwastats.com/Clan/BBB222/Weight",
        ageText: null,
        ageDays: null,
        scrapedAt: new Date("2026-03-09T00:00:00.000Z"),
        status: "login_required_no_cookie",
        httpStatus: 200,
        fromCache: false,
        error: "missing cookie",
        authErrorCode: "FWASTATS_AUTH_REQUIRED",
      },
    ]);

    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-health",
      tag: null,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const payload = editReply.mock.calls[0]?.[0];
    const content = String(payload?.content ?? "");
    expect(content).toContain("2d ago");
    expect(content).toContain("unavailable");
    expect(content).toContain("Recovery steps:");
    expect(content).toContain("/fwa weight-cookie");
  });

  it("keeps generic non-auth failures on non-auth error path", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      name: "Alpha",
    });
    vi.spyOn(FwaStatsWeightService.prototype, "getWeightAges").mockResolvedValue([
      {
        clanTag: "#ABC123",
        sourceUrl: "https://fwastats.com/Clan/ABC123/Weight",
        ageText: null,
        ageDays: null,
        scrapedAt: new Date("2026-03-09T00:00:00.000Z"),
        status: "parse_error",
        httpStatus: 200,
        fromCache: false,
        error: "parse failure",
        authErrorCode: null,
      },
    ]);

    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-age",
      tag: "ABC123",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const payload = editReply.mock.calls[0]?.[0];
    const content = String(payload?.content ?? "");
    expect(content).toContain("unavailable (parse failed)");
    expect(content).not.toContain("Recovery steps:");
  });

  it("supports /fwa weight-cookie status and save flows without exposing raw secrets", async () => {
    vi.spyOn(FwaStatsWeightCookieService.prototype, "getCookieStatus").mockResolvedValue({
      applicationCookiePresent: true,
      antiforgeryCookiePresent: true,
      applicationCookieExpiresAt: new Date("2026-03-10T00:00:00.000Z"),
      updatedAt: new Date("2026-03-09T00:00:00.000Z"),
      runtimeCookieSource: "settings",
    });
    const setSpy = vi.spyOn(FwaStatsWeightCookieService.prototype, "setCookies").mockResolvedValue({
      savedAt: new Date("2026-03-09T01:00:00.000Z"),
      applicationCookieName: ".AspNetCore.Identity.Application",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.abc",
      applicationCookieExpiresAt: null,
    });

    const statusRun = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
    });
    await Fwa.run({} as any, statusRun.interaction as any, {} as any);
    const statusContent = String(statusRun.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(statusContent).toContain("FWA Stats Weight Cookie Status");
    expect(statusContent).toContain("Application cookie: present");

    const setRun = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
      applicationCookie: "super-secret",
      antiforgeryCookie: "also-secret",
    });
    await Fwa.run({} as any, setRun.interaction as any, {} as any);
    const setContent = String(setRun.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationCookieRaw: "super-secret",
        antiforgeryCookieRaw: "also-secret",
        antiforgeryCookieNameRaw: null,
      })
    );
    expect(setContent).toContain("FWA Stats weight cookies saved.");
    expect(setContent).not.toContain("super-secret");
    expect(setContent).not.toContain("also-secret");
  });

  it("forwards optional antiforgery-cookie-name during save", async () => {
    const setSpy = vi.spyOn(FwaStatsWeightCookieService.prototype, "setCookies").mockResolvedValue({
      savedAt: new Date("2026-03-09T01:00:00.000Z"),
      applicationCookieName: ".AspNetCore.Identity.Application",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.custom",
      applicationCookieExpiresAt: null,
    });

    const run = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
      applicationCookie: "super-secret",
      antiforgeryCookie: "also-secret",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.custom",
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        antiforgeryCookieNameRaw: ".AspNetCore.Antiforgery.custom",
      })
    );
  });

  it("shows expiration unknown fallback when status has no parseable expiry", async () => {
    vi.spyOn(FwaStatsWeightCookieService.prototype, "getCookieStatus").mockResolvedValue({
      applicationCookiePresent: true,
      antiforgeryCookiePresent: true,
      applicationCookieExpiresAt: null,
      updatedAt: new Date("2026-03-09T00:00:00.000Z"),
      runtimeCookieSource: "settings",
    });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("Application cookie expiry: expiration unknown");
    expect(content).toContain("Last updated:");
  });

  it("rejects partial /fwa weight-cookie input", async () => {
    const setSpy = vi.spyOn(FwaStatsWeightCookieService.prototype, "setCookies").mockResolvedValue({
      savedAt: new Date("2026-03-09T01:00:00.000Z"),
      applicationCookieName: ".AspNetCore.Identity.Application",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.abc",
      applicationCookieExpiresAt: null,
    });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
      applicationCookie: "super-secret",
      antiforgeryCookie: null,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("Provide both `application-cookie` and `antiforgery-cookie`");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("rejects antiforgery-cookie-name without cookie values", async () => {
    const setSpy = vi.spyOn(FwaStatsWeightCookieService.prototype, "setCookies").mockResolvedValue({
      savedAt: new Date("2026-03-09T01:00:00.000Z"),
      applicationCookieName: ".AspNetCore.Identity.Application",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.abc",
      applicationCookieExpiresAt: null,
    });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
      antiforgeryCookieName: ".AspNetCore.Antiforgery.custom",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("Provide both `application-cookie` and `antiforgery-cookie`");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("rejects empty /fwa weight-cookie values", async () => {
    const setSpy = vi.spyOn(FwaStatsWeightCookieService.prototype, "setCookies").mockResolvedValue({
      savedAt: new Date("2026-03-09T01:00:00.000Z"),
      applicationCookieName: ".AspNetCore.Identity.Application",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.abc",
      applicationCookieExpiresAt: null,
    });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
      applicationCookie: "   ",
      antiforgeryCookie: "also-secret",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("Cookie values cannot be empty");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("blocks unauthorized users from updating weight cookies", async () => {
    const canUseSpy = vi
      .spyOn(CommandPermissionService.prototype, "canUseCommand")
      .mockResolvedValue(false);
    const setSpy = vi.spyOn(FwaStatsWeightCookieService.prototype, "setCookies").mockResolvedValue({
      savedAt: new Date("2026-03-09T01:00:00.000Z"),
      applicationCookieName: ".AspNetCore.Identity.Application",
      antiforgeryCookieName: ".AspNetCore.Antiforgery.abc",
      applicationCookieExpiresAt: null,
    });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-cookie",
      tag: null,
      applicationCookie: "super-secret",
      antiforgeryCookie: "also-secret",
      isAdmin: false,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("You do not have permission to manage fwastats weight cookies");
    expect(canUseSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
