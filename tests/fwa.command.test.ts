import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  trackedClan: {
    findFirst: vi.fn(),
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
  visibility?: "private" | "public";
  copyPaste?: boolean;
  checklist?: boolean;
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
      getSubcommand: vi.fn(() => "match"),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return params.visibility ?? "private";
        if (name === "tag") return params.tag ?? "ABC123";
        if (name === "debug-mail-status") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "copy_paste") return params.copyPaste ?? false;
        if (name === "checklist") return params.checklist ?? false;
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
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
  });

  it("normalizes checklist:true into copy-paste and public visibility", () => {
    const normalized = normalizeFwaMatchResponseModeForTest({
      visibility: "private",
      copyPaste: false,
      checklist: true,
    });

    expect(normalized.normalizedChecklist).toBe(true);
    expect(normalized.normalizedCopyPaste).toBe(true);
    expect(normalized.normalizedVisibility).toBe("public");
    expect(normalized.isPublic).toBe(true);
  });

  it("forces public visibility when copy_paste:true is requested", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: true,
      checklist: false,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Clan #ABC123 is not in tracked clans.",
      }),
    );
  });

  it("treats checklist:true as public output even without copy_paste", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: false,
      checklist: true,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: false });
  });

  it("keeps private non-copy-paste match replies ephemeral", async () => {
    const run = makeMatchInteraction({
      visibility: "private",
      copyPaste: false,
      checklist: false,
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });
});
