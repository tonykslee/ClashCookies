import { describe, expect, it, vi, beforeEach } from "vitest";

const blacklistClanServiceMock = vi.hoisted(() => ({
  upsertBlacklistClanTags: vi.fn(),
}));

const blacklistMatchSampleServiceMock = vi.hoisted(() => ({
  rebuildBlacklistMatchSamples: vi.fn(),
}));

const blacklistHeatmapRefServiceMock = vi.hoisted(() => ({
  rebuildBlacklistHeatmapRef: vi.fn(),
}));

const fwaMatchChecklistStateServiceMock = vi.hoisted(() => ({
  buildFwaMatchChecklistRenderStateForGuild: vi.fn().mockResolvedValue({
    rows: [
      {
        clanTag: "#PYPY",
        compactCopyLine: "📬 | 🟢 | RR vs `Bravo` (`#B1`)",
        badgeEmojiId: "111",
        badgeEmojiName: "rr",
        badgeEmojiInline: "<:rr:111>",
        contextKey: "ctx-rr",
      },
    ],
    scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=ctx-rr",
    checkedClanTags: ["#PYPY"],
    referenceId: "sync-message-1",
    emptyMessage: null,
  }),
}));

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  clanPointsSync: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  trackedMessage: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

vi.mock("../src/services/BlacklistClanService", () => ({
  blacklistClanService: blacklistClanServiceMock,
}));

vi.mock("../src/services/BlacklistMatchSampleService", () => ({
  blacklistMatchSampleService: blacklistMatchSampleServiceMock,
}));

vi.mock("../src/services/BlacklistHeatmapRefService", () => ({
  blacklistHeatmapRefService: blacklistHeatmapRefServiceMock,
}));

vi.mock("../src/services/FwaMatchChecklistStateService", () => ({
  buildFwaMatchChecklistRenderStateForGuild:
    fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild,
}));

import {
  Fwa,
  normalizeFwaMatchResponseModeForTest,
} from "../src/commands/Fwa";
import { trackedMessageService } from "../src/services/TrackedMessageService";

function makeMatchInteraction(params: {
  subcommand?: "match" | "match-checklist" | "blacklist-import" | "rebuild";
  subcommandGroup?: "blacklist-samples" | "blacklist-profile" | null;
  visibility?: "private" | "public";
  type?: "Mail" | "Bases";
  clan?: string | null;
  checked?: boolean | null;
  copyPaste?: boolean;
  tag?: string | null;
  tags?: string | null;
  sourceLabel?: string | null;
  active?: boolean | null;
  isAdmin?: boolean;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    deferReply,
    editReply,
    memberPermissions: {
      has: vi.fn(() => Boolean(params.isAdmin)),
    },
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => params.subcommandGroup ?? null),
      getSubcommand: vi.fn(() => params.subcommand ?? "match"),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return params.visibility ?? "private";
        if (name === "type") return params.type ?? null;
        if (name === "clan") return params.clan ?? null;
        if (name === "tag") return params.tag ?? "ABC123";
        if (name === "tags") return params.tags ?? null;
        if (name === "source-label") return params.sourceLabel ?? null;
        if (name === "debug-mail-status") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "checked") return params.checked ?? null;
        if (name === "copy_paste") return params.copyPaste ?? false;
        if (name === "active") return params.active ?? true;
        if (name === "debug-mail-status") return false;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/fwa match response normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
    prismaMock.clanPointsSync.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    blacklistClanServiceMock.upsertBlacklistClanTags.mockReset();
    blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples.mockReset();
    blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef.mockReset();
    blacklistClanServiceMock.upsertBlacklistClanTags.mockResolvedValue({
      sourceLabel: "manual-import",
      active: true,
      added: [],
      updated: [],
      invalid: [],
      duplicateInRequest: [],
      totalRequested: 0,
    });
    blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples.mockResolvedValue({
      status: "success",
      reason: null,
      activeBlacklistCount: 1,
      fwaClanCount: 1,
      candidateWarCount: 1,
      qualifyingSampleCount: 1,
      skippedCandidateCount: 0,
      addedCount: 1,
      updatedCount: 0,
      summaryLines: ["sample summary"],
    });
    blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef.mockResolvedValue({
      status: "success",
      reason: null,
      usableSampleCount: 4,
      bandCount: 2,
      addedCount: 2,
      updatedCount: 0,
      removedCount: 0,
      summaryLines: ["profile summary"],
    });
  });

  it("normalizes copy-paste into public visibility", () => {
    const normalized = normalizeFwaMatchResponseModeForTest({
      visibility: "private",
      copyPaste: true,
    });

    expect(normalized.normalizedCopyPaste).toBe(true);
    expect(normalized.normalizedVisibility).toBe("public");
    expect(normalized.isPublic).toBe(true);
  });

  it("forces public visibility when copy_paste:true is requested", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Clan #ABC123 is not in tracked clans.",
      }),
    );
  });

  it("keeps private non-copy-paste match replies ephemeral", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: false,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it("renders the checklist snapshot command without requiring copy-paste", async () => {
    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Mail Checklist"),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("📬 | 🟢 | ✅ | RR vs `Bravo` (`#B1`)"),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "React with your clan's badge to indicate that the in-game mails have been sent.",
        ),
      }),
    );
  });

  it("renders the bases checklist snapshot command as read-only text", async () => {
    fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: null,
          badgeEmojiName: null,
          badgeEmojiInline: "",
        },
      ],
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
      checkedClanTags: [],
      referenceId: null,
      expiresAt: new Date("2026-05-13T22:00:00.000Z"),
      emptyMessage: null,
    } as any);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
      type: "Bases",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(fwaMatchChecklistStateServiceMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Bases Checklist"),
        components: [],
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("❌ Bases not checked"),
      }),
    );
  });

  it("persists a bases checked completion for the current war", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findFirst.mockImplementation(async ({ where }) => {
      const candidates = Array.isArray(where?.OR) ? where.OR : [];
      const found = candidates.some(
        (candidate: { clanTag?: string | null }) => candidate?.clanTag === "PYPY",
      );
      return found
        ? {
            warId: 1001,
            startTime: new Date("2026-05-13T18:00:00.000Z"),
            opponentTag: "#OPP1",
            state: "preparation",
          }
        : null;
    });
    const completionSpy = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "public",
      type: "Bases",
      clan: "A",
      checked: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(completionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        createdByUserId: "user-1",
        clanTag: "#PYPY",
        checked: true,
        warId: 1001,
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
      }),
    );
    expect(prismaMock.currentWar.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          OR: expect.arrayContaining([
            { clanTag: "PYPY" },
            { clanTag: "#PYPY" },
          ]),
        }),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Bases checked and all good saved"),
      }),
    );
  });

  it("clears a bases checked completion for the current war", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYPY", name: "Alpha", shortName: "A" },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      warId: 1001,
      startTime: new Date("2026-05-13T18:00:00.000Z"),
      opponentTag: "#OPP1",
      state: "battle",
    });
    const completionSpy = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);

    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
      type: "Bases",
      clan: "A",
      checked: false,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(completionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#PYPY",
        checked: false,
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Cleared all-good bases state"),
      }),
    );
  });

  it("rejects clan and checked when provided for mail mode", async () => {
    const completionSpy = vi.spyOn(
      trackedMessageService,
      "setFwaMatchChecklistBasesCompletion",
    );
    const run = makeMatchInteraction({
      subcommand: "match-checklist",
      visibility: "private",
      type: "Mail",
      clan: "Alpha",
      checked: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "`clan` and `checked` only apply to `type:Bases`.",
      }),
    );
    expect(completionSpy).not.toHaveBeenCalled();
  });

  it("imports blacklist clans through the new admin command path", async () => {
    blacklistClanServiceMock.upsertBlacklistClanTags.mockResolvedValueOnce({
      sourceLabel: "manual-import",
      active: false,
      added: ["#PYLQ0289", "#PYLQ0288", "#PYLQ0280"],
      updated: [],
      invalid: [],
      duplicateInRequest: ["#PYLQ0289"],
      totalRequested: 4,
    });
    const run = makeMatchInteraction({
      subcommand: "blacklist-import",
      tags: "#PYLQ0289, PYLQ0288 PYLQ0280 #PYLQ0289",
      sourceLabel: "manual-import",
      active: false,
      isAdmin: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(blacklistClanServiceMock.upsertBlacklistClanTags).toHaveBeenCalledWith(
      expect.objectContaining({
        rawTags: "#PYLQ0289, PYLQ0288 PYLQ0280 #PYLQ0289",
        sourceLabel: "manual-import",
        active: false,
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Blacklist registry updated from `manual-import` (inactive)."),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Added: **3**"),
      }),
    );
  });

  it("rejects blacklist import for non-admin users", async () => {
    const run = makeMatchInteraction({
      subcommand: "blacklist-import",
      tags: "#AAA111",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(blacklistClanServiceMock.upsertBlacklistClanTags).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only administrators can use this command.",
      }),
    );
  });

  it("rebuilds blacklist matchup samples through the new admin command path", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-samples",
      subcommand: "rebuild",
      isAdmin: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples).toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Blacklist matchup samples rebuilt."),
        components: expect.any(Array),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("sample summary"),
      }),
    );
  });

  it("rebuilds the blacklist heatmapref profile through the new admin command path", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-profile",
      subcommand: "rebuild",
      isAdmin: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef).toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Blacklist heatmapref profile rebuilt."),
      }),
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("profile summary"),
      }),
    );
  });

  it("rejects blacklist sample rebuild for non-admin users", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-samples",
      subcommand: "rebuild",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only administrators can use this command.",
      }),
    );
  });

  it("rejects blacklist heatmapref profile rebuild for non-admin users", async () => {
    const run = makeMatchInteraction({
      subcommandGroup: "blacklist-profile",
      subcommand: "rebuild",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(blacklistHeatmapRefServiceMock.rebuildBlacklistHeatmapRef).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only administrators can use this command.",
      }),
    );
  });
});
