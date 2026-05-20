import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
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
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

import {
  Fwa,
  normalizeFwaMatchResponseModeForTest,
} from "../src/commands/Fwa";

function makeMatchInteraction(params: {
  subcommand?: "match" | "match-checklist";
  visibility?: "private" | "public";
  copyPaste?: boolean;
  tag?: string | null;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => params.subcommand ?? "match"),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return params.visibility ?? "private";
        if (name === "tag") return params.tag ?? "ABC123";
        if (name === "debug-mail-status") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "copy_paste") return params.copyPaste ?? false;
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
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
    prismaMock.clanPointsSync.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
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
});
