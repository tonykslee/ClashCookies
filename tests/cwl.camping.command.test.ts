import { beforeEach, describe, expect, it, vi } from "vitest";

const campingServiceMock = vi.hoisted(() => ({
  getCamping: vi.fn(),
}));

vi.mock("../src/services/CwlAllianceCampingService", () => ({
  cwlAllianceCampingService: campingServiceMock,
}));

import { Cwl } from "../src/commands/Cwl";
import { cwlAllianceCampingService } from "../src/services/CwlAllianceCampingService";
import { resolveCurrentCwlSeasonKey } from "../src/services/CwlRegistryService";

const day = 24 * 60 * 60 * 1000;

function makeResult(overrides: Record<string, unknown> = {}): any {
  return {
    season: "2026-08",
    reportNow: new Date("2026-08-10T00:00:00.000Z"),
    cwlWindow: {
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-08T00:00:00.000Z"),
      timingCoverageComplete: true,
      missingTimingDetails: [],
    },
    timing: { available: true, reason: null },
    trackingCoverage: {
      status: "OBSERVED",
      trackingStartedAt: new Date("2026-07-01T00:00:00.000Z"),
      reason: null,
    },
    summary: {
      attributedPreFwaAccounts: 2,
      camperCount: 1,
      zeroObservedCampingCount: 1,
      totalCampingDurationMs: 3 * day,
      averageCampingDurationMs: 3 * day,
      medianCampingDurationMs: 3 * day,
      postCwlCamperCount: 1,
      totalPostCwlCampingDurationMs: day,
      currentlyCampingCount: 1,
    },
    unattributed: { observedAccountCount: 1, observedDurationMs: 2 * day },
    players: [{
      playerTag: "#PYLQ2222",
      playerName: "Player One",
      homeFwaClanTag: "#QGRJ9999",
      cwlClanTagsVisited: ["#QGRJ2222"],
      duringCwlDurationMs: 3 * day,
      postCwlDurationMs: day,
      totalObservedCampingDurationMs: 4 * day,
      currentlyCamping: true,
      currentCwlClanTag: "#QGRJ2222",
      currentCampingSince: new Date("2026-08-02T00:00:00.000Z"),
    }],
    clans: [{
      clanTag: "#QGRJ2222",
      clanName: "CWL One",
      uniqueAttributedCamperCount: 1,
      totalDuringCwlCampingDurationMs: 3 * day,
      totalPostCwlCampingDurationMs: day,
      currentlyCampingCount: 1,
    }],
    overlapReconciliationCount: 0,
    intervalRowCount: 1,
    ...overrides,
  };
}

function makeInteraction(input: { season?: string | null; view?: string | null; page?: number | null } = {}) {
  return {
    guildId: "guild-1",
    inGuild: vi.fn().mockReturnValue(true),
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue("camping"),
      getString: vi.fn((name: string) => name === "season" ? input.season ?? null : name === "view" ? input.view ?? null : null),
      getInteger: vi.fn((name: string) => name === "page" ? input.page ?? null : null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function getEmbed(interaction: any): any {
  return interaction.editReply.mock.calls.at(-1)?.[0]?.embeds?.[0]?.toJSON?.();
}

describe("/cwl camping", () => {
  beforeEach(() => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockReset();
  });

  it("uses the canonical current season and defaults to the summary view", async () => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult());
    const interaction = makeInteraction();

    await Cwl.run({} as any, interaction);

    expect(cwlAllianceCampingService.getCamping).toHaveBeenCalledWith({
      season: resolveCurrentCwlSeasonKey(),
      guildId: "guild-1",
    });
    expect(getEmbed(interaction).title).toContain("CWL Camping");
    expect(getEmbed(interaction).description).toContain("Observed camping time");
  });

  it("renders full-coverage summary metrics and unattributed evidence", async () => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult());
    const interaction = makeInteraction({ season: "2026-08", view: "summary" });

    await Cwl.run({} as any, interaction);

    const description = getEmbed(interaction).description;
    expect(description).toContain("Tracking: **OBSERVED**");
    expect(description).toContain("Observed campers: **1**");
    expect(description).toContain("No camping observed: **1**");
    expect(description).toContain("Unattributed CWL-clan observations: **1 accounts / 2d**");
  });

  it("warns prominently for partial coverage without claiming zero camping", async () => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult({
      trackingCoverage: {
        status: "PARTIAL",
        trackingStartedAt: new Date("2026-08-03T00:00:00.000Z"),
        reason: "Membership tracking began after CWL started; earlier membership is unobserved.",
      },
    }));
    const interaction = makeInteraction({ view: "players" });

    await Cwl.run({} as any, interaction);

    const description = getEmbed(interaction).description;
    expect(description).toContain("Partial — membership tracking began after CWL started");
    expect(description).not.toContain("No camping observed:");
  });

  it("renders unavailable tracking without a page of zeroes", async () => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult({
      trackingCoverage: {
        status: "UNAVAILABLE",
        trackingStartedAt: null,
        reason: "No observed membership history exists for this guild.",
      },
      players: [],
      clans: [],
    }));
    const interaction = makeInteraction({ view: "summary" });

    await Cwl.run({} as any, interaction);

    const description = getEmbed(interaction).description;
    expect(description).toContain("Observed membership history unavailable");
    expect(description).not.toContain("Observed campers:");
  });

  it("paginates players deterministically", async () => {
    const players = Array.from({ length: 21 }, (_, index) => ({
      ...makeResult().players[0],
      playerTag: `#PYLQ${String(index + 1000).padStart(4, "0")}`,
      playerName: `Player ${index + 1}`,
    }));
    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult({ players }));
    const interaction = makeInteraction({ view: "players", page: 2 });

    await Cwl.run({} as any, interaction);

    expect(getEmbed(interaction).description).toContain("Player 21");
    expect(getEmbed(interaction).description).toContain("Page 2/2");
  });

  it("renders clans and changes current-view wording for ongoing versus completed CWL", async () => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult());
    const clansInteraction = makeInteraction({ view: "clans" });
    await Cwl.run({} as any, clansInteraction);
    expect(getEmbed(clansInteraction).description).toContain("CWL One");
    expect(getEmbed(clansInteraction).description).toContain("3d");

    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult({
      cwlWindow: { ...makeResult().cwlWindow, endsAt: null },
      summary: { ...makeResult().summary, postCwlCamperCount: null, totalPostCwlCampingDurationMs: null },
      players: [{ ...makeResult().players[0], postCwlDurationMs: null }],
    }));
    const ongoingInteraction = makeInteraction({ view: "current" });
    await Cwl.run({} as any, ongoingInteraction);
    expect(getEmbed(ongoingInteraction).title).toContain("Currently in CWL clans");

    vi.mocked(cwlAllianceCampingService.getCamping).mockResolvedValueOnce(makeResult());
    const completedInteraction = makeInteraction({ view: "current" });
    await Cwl.run({} as any, completedInteraction);
    expect(getEmbed(completedInteraction).title).toContain("Still camping after CWL");
  });

  it("returns a bounded failure when camping history cannot be read", async () => {
    vi.mocked(cwlAllianceCampingService.getCamping).mockRejectedValueOnce(new Error("db unavailable"));
    const interaction = makeInteraction();

    await Cwl.run({} as any, interaction);

    expect(interaction.editReply).toHaveBeenLastCalledWith("Failed to load CWL camping from persisted membership history.");
  });
});
