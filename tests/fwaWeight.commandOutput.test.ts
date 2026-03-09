import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Fwa } from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";
import { FwaStatsWeightService } from "../src/services/FwaStatsWeightService";

function makeInteraction(params: {
  subcommand: "weight-age" | "weight-health";
  tag: string | null;
  visibility?: "private" | "public";
  guildId?: string;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: params.guildId ?? "guild-1",
    user: { id: "user-1" },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => params.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag;
        if (name === "visibility") return params.visibility ?? "private";
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
      },
    ]);

    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-age",
      tag: "ABC123",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const payload = editReply.mock.calls[0]?.[0];
    expect(String(payload?.content ?? "")).toContain(
      "Alpha (#ABC123) — unavailable (auth cookie rejected/expired)"
    );
    expect(String(payload?.content ?? "")).toContain(
      "Auth required: fwastats rejected `FWASTATS_WEIGHT_COOKIE`."
    );
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
      },
    ]);

    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-health",
      tag: null,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const payload = editReply.mock.calls[0]?.[0];
    const content = String(payload?.content ?? "");
    expect(content).toContain("Alpha (#AAA111) — 2d ago ✅");
    expect(content).toContain("Bravo (#BBB222) — unavailable ❓");
    expect(content).toContain("Auth required: set `FWASTATS_WEIGHT_COOKIE` in secrets");
  });
});
