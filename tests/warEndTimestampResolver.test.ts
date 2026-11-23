import { describe, expect, it, vi } from "vitest";

import { WarEventHistoryService } from "../src/services/war-events/history";
import { resolveCanonicalWarEndTimestamp } from "../src/services/war-events/warEndTimestampResolver";

const endTime = new Date("2026-09-10T18:00:00.000Z");

describe("resolveCanonicalWarEndTimestamp", () => {
  it("prefers an exact CurrentWar timestamp only when WarAttacks corroborates it", () => {
    expect(
      resolveCanonicalWarEndTimestamp({
        observations: [
          {
            source: "CURRENT_WAR",
            timestamp: endTime,
            exactWar: true,
            directApiObserved: false,
          },
          {
            source: "WAR_ATTACKS",
            timestamp: new Date(endTime),
            exactWar: true,
            directApiObserved: true,
          },
        ],
      }),
    ).toMatchObject({
      timestamp: endTime,
      source: "CURRENT_WAR",
      evidenceStatus: "VERIFIED",
      reasonCode: "CURRENT_WAR_CORROBORATED",
    });
  });

  it("uses an exact direct WarAttacks timestamp when CurrentWar is absent", () => {
    expect(
      resolveCanonicalWarEndTimestamp({
        observations: [
          {
            source: "WAR_ATTACKS",
            timestamp: endTime,
            exactWar: true,
            directApiObserved: true,
          },
          {
            source: "WAR_ATTACKS",
            timestamp: new Date(endTime),
            exactWar: true,
            directApiObserved: true,
          },
        ],
      }),
    ).toMatchObject({
      timestamp: endTime,
      source: "WAR_ATTACKS",
      evidenceStatus: "VERIFIED",
      reasonCode: "WAR_ATTACKS_FALLBACK",
    });
  });

  it("fails closed for a derived or uncorroborated CurrentWar timestamp", () => {
    expect(
      resolveCanonicalWarEndTimestamp({
        observations: [
          {
            source: "CURRENT_WAR",
            timestamp: endTime,
            exactWar: true,
            directApiObserved: false,
          },
        ],
      }),
    ).toMatchObject({
      timestamp: null,
      source: "UNKNOWN",
      evidenceStatus: "UNKNOWN",
      reasonCode: "CURRENT_WAR_UNCORROBORATED",
    });
  });

  it("rejects wrong-war, malformed, and conflicting WarAttacks evidence", () => {
    expect(
      resolveCanonicalWarEndTimestamp({
        observations: [
          {
            source: "WAR_ATTACKS",
            timestamp: endTime,
            exactWar: false,
            directApiObserved: true,
          },
        ],
      }).timestamp,
    ).toBeNull();

    expect(
      resolveCanonicalWarEndTimestamp({
        observations: [
          {
            source: "WAR_ATTACKS",
            timestamp: null,
            exactWar: true,
            directApiObserved: true,
          },
        ],
      }),
    ).toMatchObject({
      timestamp: null,
      evidenceStatus: "UNKNOWN",
      reasonCode: "MALFORMED_WAR_ATTACK_TIMESTAMP",
    });

    expect(
      resolveCanonicalWarEndTimestamp({
        observations: [
          {
            source: "WAR_ATTACKS",
            timestamp: endTime,
            exactWar: true,
            directApiObserved: true,
          },
          {
            source: "WAR_ATTACKS",
            timestamp: new Date("2026-09-10T18:00:01.000Z"),
            exactWar: true,
            directApiObserved: true,
          },
        ],
      }),
    ).toMatchObject({
      timestamp: null,
      evidenceStatus: "CONFLICTING",
      reasonCode: "CONFLICTING_WAR_ATTACKS",
    });
  });

  it("does not let unrelated or ambiguous war-log rows replace safe result fallbacks", async () => {
    const coc = {
      getClanWarLog: vi.fn().mockResolvedValue([
        {
          endTime: "20260910T180000.000Z",
          clan: { stars: 99 },
          opponent: { tag: "#OTHER", stars: 0 },
          result: "win",
        },
        {
          opponent: { tag: "#OPP" },
          endTime: "20260910T180000.000Z",
          clan: { stars: 50 },
          result: "win",
        },
        {
          opponent: { tag: "#OPP" },
          endTime: "20260910T180000.000Z",
          clan: { stars: 1 },
          result: "lose",
        },
      ]),
    };
    const service = new WarEventHistoryService(coc as any, {} as any, {} as any, {} as any, {} as any);

    const result = await service.getWarEndResultSnapshot({
      clanTag: "#CLAN",
      opponentTag: "#OPP",
      fallbackClanStars: 3,
      fallbackOpponentStars: 2,
      warStartTime: new Date("2026-09-09T18:00:00.000Z"),
      verifiedWarEndTime: endTime,
    });

    expect(result).toMatchObject({
      clanStars: 3,
      opponentStars: 2,
      resultLabel: "WIN",
      warEndTime: null,
    });
  });
});
