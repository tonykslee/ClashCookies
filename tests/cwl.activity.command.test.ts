import { beforeEach, describe, expect, it, vi } from "vitest";

const activityServiceMock = vi.hoisted(() => ({
  getActivity: vi.fn(),
}));

vi.mock("../src/services/CwlAllianceActivityService", () => ({
  cwlAllianceActivityService: activityServiceMock,
}));

import { Cwl } from "../src/commands/Cwl";
import { cwlAllianceActivityService } from "../src/services/CwlAllianceActivityService";
import { resolveCurrentCwlSeasonKey } from "../src/services/CwlRegistryService";

function makeResult(overrides: Record<string, unknown> = {}): any {
  return {
    season: "2026-08",
    cwlWindow: {
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-08T00:00:00.000Z"),
      timingCoverageComplete: true,
      missingTimingDetails: [],
    },
    coverage: {
      cwlClanCount: 1,
      resolvedEventCount: 1,
      unresolvedCwlClans: [],
      preFwaClansExpected: 1,
      preFwaClansCovered: 1,
      postCoverageComplete: true,
      coveredPostClanCount: 1,
      expectedPostClanCount: 1,
      duplicateReconciliations: 0,
    },
    totals: {
      preFwaCount: 2,
      cwlParticipantCount: 2,
      bothCount: 1,
      fwaOnlyCount: 1,
      cwlOnlyCount: 1,
    },
    percentages: {
      cwlParticipantsOfPreFwa: 100,
      bothOfPreFwa: 50,
      fwaOnlyOfPreFwa: 50,
      cwlOnlyOfCwl: 50,
    },
    participationDayHistogram: { "1": 1, "2": 1, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0 },
    unexpectedParticipationDays: {},
    preCwlClans: [{
      clanTag: "#FWA1",
      clanName: "FWA One",
      coverageAvailable: true,
      unavailableReason: null,
      sourcePreCwlWar: null,
      preCwlRosterCount: 3,
      sourcePreCwlRosterCount: 99,
      cwlParticipantCount: 2,
      fwaOnlyCount: 1,
      bothCount: 1,
      returnedAfterCwlCount: 2,
      retentionRate: 66.7,
      sourcePostCwlWar: null,
    }],
    players: {
      preFwa: [{ playerTag: "#P1", playerName: "Player One", townHall: 16, homeFwaClanTag: "#FWA1" }],
      cwl: [{ playerTag: "#P1", playerName: "Player One", townHall: 16, cwlClanTag: "#CWL1", daysParticipated: 7 }],
      both: [{ playerTag: "#P1", playerName: "Player One", townHall: 16, homeFwaClanTag: "#FWA1", cwlClanTag: "#CWL1", daysParticipated: 7 }],
      fwaOnly: [{ playerTag: "#P2", playerName: "Player Two", townHall: 15, homeFwaClanTag: "#FWA1" }],
      cwlOnly: [{ playerTag: "#P3", playerName: "Player Three", townHall: 14, cwlClanTag: "#CWL1", daysParticipated: 2 }],
    },
    movementSummary: [],
    postCwlRetention: {
      available: true,
      returnedAfterCwl: [{ playerTag: "#P1", playerName: "Player One", townHall: 16, homeFwaClanTag: "#FWA1" }],
      notReturnedAfterCwl: [],
      newPostCwlFwa: [],
      retentionRate: 50,
    },
    ...overrides,
  };
}

function makeInteraction(input: { season?: string | null; view?: string | null; page?: number | null } = {}) {
  return {
    guildId: "guild-1",
    inGuild: vi.fn().mockReturnValue(true),
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue("activity"),
      getString: vi.fn((name: string) => name === "season" ? input.season ?? null : name === "view" ? input.view ?? null : null),
      getInteger: vi.fn((name: string) => name === "page" ? input.page ?? null : null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function getDescription(interaction: any): string {
  const payload = interaction.editReply.mock.calls.at(-1)?.[0];
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

describe("/cwl activity", () => {
  beforeEach(() => {
    vi.mocked(cwlAllianceActivityService.getActivity).mockReset();
  });

  it("uses the current season by default and passes the guild to the DB-first service", async () => {
    const result = makeResult();
    vi.mocked(cwlAllianceActivityService.getActivity).mockResolvedValueOnce(result);
    const interaction = makeInteraction();

    await Cwl.run({} as any, interaction);

    expect(cwlAllianceActivityService.getActivity).toHaveBeenCalledWith({
      season: resolveCurrentCwlSeasonKey(),
      guildId: "guild-1",
    });
    expect(getDescription(interaction)).toContain("Participation");
    expect(getDescription(interaction)).toContain("CWL Days");
    expect(getDescription(interaction)).toContain("Both FWA + CWL");
  });

  it("renders deterministic paged player detail without another data fetch", async () => {
    const result = makeResult({
      players: {
        ...makeResult().players,
        both: Array.from({ length: 21 }, (_, index) => ({
          playerTag: `#P${index + 1}`,
          playerName: `Player ${index + 1}`,
          townHall: 16,
          homeFwaClanTag: "#FWA1",
          cwlClanTag: "#CWL1",
          daysParticipated: 7,
        })),
      },
    });
    vi.mocked(cwlAllianceActivityService.getActivity).mockResolvedValueOnce(result);
    const interaction = makeInteraction({ season: "2026-08", view: "both", page: 2 });

    await Cwl.run({} as any, interaction);

    const description = getDescription(interaction);
    expect(description).toContain("Player 21");
    expect(description).toContain("Page 2/2");
    expect(description).toContain("#FWA1 → #CWL1 | 7d");
    expect(cwlAllianceActivityService.getActivity).toHaveBeenCalledTimes(1);
  });

  it("does not show a retention percentage when post-CWL coverage is incomplete", async () => {
    const result = makeResult({
      coverage: { ...makeResult().coverage, postCoverageComplete: false, coveredPostClanCount: 1, expectedPostClanCount: 2 },
      postCwlRetention: { ...makeResult().postCwlRetention, retentionRate: null },
    });
    vi.mocked(cwlAllianceActivityService.getActivity).mockResolvedValueOnce(result);
    const interaction = makeInteraction({ view: "summary" });

    await Cwl.run({} as any, interaction);

    const description = getDescription(interaction);
    expect(description).toContain("Post-CWL retention unavailable");
    expect(description).toContain("Coverage: **1/2** clans");
    expect(description).not.toMatch(/Returned:.*\(/);
  });

  it("uses reconciled pre-CWL roster counts in the clans view", async () => {
    vi.mocked(cwlAllianceActivityService.getActivity).mockResolvedValueOnce(makeResult());
    const interaction = makeInteraction({ view: "clans" });

    await Cwl.run({} as any, interaction);

    const description = getDescription(interaction);
    expect(description).toContain("pre 3");
    expect(description).not.toContain("pre 99");
  });

  it("returns a bounded failure message when persisted activity cannot be read", async () => {
    vi.mocked(cwlAllianceActivityService.getActivity).mockRejectedValueOnce(new Error("db unavailable"));
    const interaction = makeInteraction();

    await Cwl.run({} as any, interaction);

    expect(getDescription(interaction)).toBe("");
    expect(interaction.editReply).toHaveBeenCalledWith("Failed to load CWL alliance activity from persisted data.");
  });
});
