import { describe, expect, it, vi, beforeEach } from "vitest";

const blacklistClanServiceMock = vi.hoisted(() => ({
  upsertBlacklistClanTags: vi.fn(),
}));

const blacklistMatchSampleServiceMock = vi.hoisted(() => ({
  rebuildBlacklistMatchSamples: vi.fn(),
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

import {
  Fwa,
  normalizeFwaMatchResponseModeForTest,
} from "../src/commands/Fwa";

function makeMatchInteraction(params: {
  subcommand?: "match" | "match-checklist" | "blacklist-import" | "rebuild";
  subcommandGroup?: "blacklist-samples" | null;
  visibility?: "private" | "public";
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
        if (name === "tag") return params.tag ?? "ABC123";
        if (name === "tags") return params.tags ?? null;
        if (name === "source-label") return params.sourceLabel ?? null;
        if (name === "debug-mail-status") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
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
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    blacklistClanServiceMock.upsertBlacklistClanTags.mockReset();
    blacklistMatchSampleServiceMock.rebuildBlacklistMatchSamples.mockReset();
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
        content: expect.stringContaining(
          "React with your clan's badge to indicate that the in-game mails have been sent.",
        ),
      }),
    );
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
});
