import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRetrospectiveResult } from "../src/services/SyncRetrospectiveService";

const retrospectiveMock = vi.hoisted(() => ({
  getLatestAvailableSyncNumber: vi.fn(),
  getBySyncNumber: vi.fn(),
}));

vi.mock("../src/services/SyncRetrospectiveService", () => ({
  SyncRetrospectiveService: vi.fn().mockImplementation(() => retrospectiveMock),
}));

import { Post } from "../src/commands/Post";

function retrospectiveResult(syncNumber = 545): SyncRetrospectiveResult {
  return {
    identity: {
      guildId: "guild-1",
      syncNumber,
      syncTime: new Date("2026-08-15T11:00:00.000Z"),
      cycleMapped: true,
    },
    warSummary: {
      clanWarCount: 1,
      totalStarsKnown: 100,
      starsCoverage: { known: 1, total: 1 },
    },
    missedAttacks: {
      missedAttacksKnownTotal: 0,
      coverage: { completeClans: 1, warClans: 1 },
    },
    fwaViolations: {
      violationKnownTotal: 0,
      coverage: { completedFwaEvaluations: 1, fwaWars: 1 },
    },
    readiness: {
      averageDeviation: 0,
      deviationCoverage: { valid: 1, totalSnapshots: 1 },
    },
    fillers: {
      fillerKnownTotal: 0,
      fillerCoverage: { complete: 1, totalSnapshots: 1 },
    },
    clans: [{
      identity: {
        clanTag: "#CLAN",
        clanName: "Command Clan",
        warId: 1,
        matchType: "FWA",
        expectedOutcome: "WIN",
        actualOutcome: "WIN",
      },
      war: { stars: 100 },
      missedAttacks: { total: 0, coverageComplete: true, players: [] },
      violations: { total: 0, evaluationComplete: true, applicable: true, details: [] },
      readiness: { memberCount: 50, deviationScore: 0, projectionComplete: true, dataAvailable: true },
      fillers: { fillerCount: 0, fillerPlayerTags: [], fillerCaptureComplete: true },
    }],
  };
}

function emptyRetrospectiveResult(syncNumber: number): SyncRetrospectiveResult {
  return {
    ...retrospectiveResult(syncNumber),
    warSummary: { clanWarCount: 0, totalStarsKnown: null, starsCoverage: { known: 0, total: 0 } },
    readiness: { averageDeviation: null, deviationCoverage: { valid: 0, totalSnapshots: 0 } },
  };
}

function makeInteraction(input: { syncNumber?: number | null; visibility?: string | null }) {
  const options = {
    getSubcommandGroup: vi.fn().mockReturnValue(null),
    getSubcommand: vi.fn().mockReturnValue("retrospective"),
    getInteger: vi.fn().mockReturnValue(input.syncNumber ?? null),
    getString: vi.fn((name: string) => name === "visibility" ? input.visibility ?? null : null),
  };
  return {
    inGuild: vi.fn().mockReturnValue(true),
    guildId: "guild-1",
    options,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("/sync retrospective command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retrospectiveMock.getLatestAvailableSyncNumber.mockResolvedValue(545);
    retrospectiveMock.getBySyncNumber.mockImplementation(async ({ syncNumber }: { syncNumber: number }) => retrospectiveResult(syncNumber));
  });

  it("registers an optional positive sync number and private/public visibility choices", () => {
    const retrospective = Post.options?.find((option) => option.name === "retrospective");
    expect(retrospective?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const syncNumber = retrospective?.options?.find((option: { name: string }) => option.name === "sync-number");
    const visibility = retrospective?.options?.find((option: { name: string }) => option.name === "visibility");
    expect(syncNumber).toMatchObject({
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
    });
    expect(visibility?.choices?.map((choice: { value: string }) => choice.value)).toEqual(["private", "public"]);
  });

  it("renders the older valid retrospective returned by latest-sync resolution", async () => {
    const interaction = makeInteraction({});
    await Post.run({} as any, interaction, {} as any);

    expect(retrospectiveMock.getLatestAvailableSyncNumber).toHaveBeenCalledWith({ guildId: "guild-1" });
    expect(retrospectiveMock.getBySyncNumber).toHaveBeenCalledWith({ guildId: "guild-1", syncNumber: 545 });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply.mock.calls[0][0]).toMatchObject({
      embeds: [expect.objectContaining({ data: expect.objectContaining({ title: "Sync #545 Retrospective" }) })],
    });
    expect(interaction.editReply.mock.calls[0][0].components).toHaveLength(1);
  });

  it("uses the exact explicit sync and does not fall back when it has no data", async () => {
    retrospectiveMock.getBySyncNumber.mockResolvedValueOnce(emptyRetrospectiveResult(123));
    const interaction = makeInteraction({ syncNumber: 123 });
    await Post.run({} as any, interaction, {} as any);

    expect(retrospectiveMock.getLatestAvailableSyncNumber).not.toHaveBeenCalled();
    expect(retrospectiveMock.getBySyncNumber).toHaveBeenCalledWith({ guildId: "guild-1", syncNumber: 123 });
    expect(interaction.editReply).toHaveBeenCalledWith("No retrospective data was found for Sync #123.");
  });

  it("keeps private and public output identical apart from response visibility", async () => {
    const privateInteraction = makeInteraction({ visibility: "private" });
    await Post.run({} as any, privateInteraction, {} as any);
    const privatePayload = privateInteraction.editReply.mock.calls[0][0];

    const publicInteraction = makeInteraction({ visibility: "public" });
    await Post.run({} as any, publicInteraction, {} as any);
    const publicPayload = publicInteraction.editReply.mock.calls[0][0];

    expect(privateInteraction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(publicInteraction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(publicPayload.embeds.map((embed: any) => embed.toJSON())).toEqual(
      privatePayload.embeds.map((embed: any) => embed.toJSON()),
    );
    expect(publicPayload.components.map((row: any) => row.toJSON())).toEqual(
      privatePayload.components.map((row: any) => row.toJSON()),
    );
  });

  it("returns the clear empty state when no latest retrospective exists", async () => {
    retrospectiveMock.getLatestAvailableSyncNumber.mockResolvedValueOnce(null);
    const interaction = makeInteraction({});
    await Post.run({} as any, interaction, {} as any);
    expect(interaction.editReply).toHaveBeenCalledWith("No sync retrospective data is available yet.");
  });
});
