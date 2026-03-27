import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findFirst: vi.fn(),
  },
  apiUsage: {
    upsert: vi.fn(() => Promise.resolve(undefined)),
  },
}));

const fwaPoliceServiceMock = vi.hoisted(() => ({
  setClanConfig: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

vi.mock("../src/services/FwaPoliceService", () => ({
  fwaPoliceService: fwaPoliceServiceMock,
}));

import { Fwa } from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";

function makeInteraction(input: {
  clanTag: string;
  enableDm: boolean;
  enableLog: boolean;
  visibility?: "private" | "public";
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "111111111111111111" },
    memberPermissions: {
      has: vi.fn(() => true),
    },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => "police"),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return input.visibility ?? "private";
        if (name === "clan-tag") return input.clanTag;
        if (name === "tag") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "enable-dm") return input.enableDm;
        if (name === "enable-log") return input.enableLog;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/fwa police command output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(PointsSyncService.prototype, "findLatestSyncNum").mockResolvedValue(
      null,
    );
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.clanWarHistory.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders DM-only summary and persists provided toggle values", async () => {
    fwaPoliceServiceMock.setClanConfig.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: true,
      enableLog: false,
    });

    const run = makeInteraction({
      clanTag: "2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaPoliceServiceMock.setClanConfig).toHaveBeenCalledWith({
      clanTag: "2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });
    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("FWA police updated for **Alpha** (#2QG2C08UP).");
    expect(content).toContain("DM alerts: ON | Clan logs: OFF");
  });

  it("renders log-only summary", async () => {
    fwaPoliceServiceMock.setClanConfig.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: false,
      enableLog: true,
    });

    const run = makeInteraction({
      clanTag: "#2QG2C08UP",
      enableDm: false,
      enableLog: true,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("DM alerts: OFF | Clan logs: ON");
  });

  it("renders both-enabled summary", async () => {
    fwaPoliceServiceMock.setClanConfig.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: true,
      enableLog: true,
    });

    const run = makeInteraction({
      clanTag: "2QG2C08UP",
      enableDm: true,
      enableLog: true,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("DM alerts: ON | Clan logs: ON");
  });

  it("renders disabled summary when both toggles are false", async () => {
    fwaPoliceServiceMock.setClanConfig.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: false,
      enableLog: false,
    });

    const run = makeInteraction({
      clanTag: "2QG2C08UP",
      enableDm: false,
      enableLog: false,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain(
      "Both DM and log actions are OFF (automation disabled for this clan).",
    );
  });
});

