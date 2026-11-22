import { describe, expect, it } from "vitest";
import {
  evaluateFwaWarMembersSourceEvidence,
  validateFwaWarMembersSourceEvidence,
} from "../src/services/fwa-feeds/FwaWarMembersSourceEvidence";
import type { FwaWarMemberFeedRow } from "../src/services/fwa-feeds/types";

const now = new Date("2026-11-21T12:00:00.000Z");

function row(position: number, weight = 181000): FwaWarMemberFeedRow {
  return {
    clanTag: "#CLAN1",
    playerTag: `#PLAYER${position}`,
    playerName: `Player ${position}`,
    position,
    townHall: 19,
    weight,
    opponentTag: "#OPP1",
    opponentName: "Opponent",
    attacks: 0,
    defender1Tag: null,
    defender1Name: null,
    defender1TownHall: null,
    defender1Position: null,
    stars1: null,
    destructionPercentage1: null,
    defender2Tag: null,
    defender2Name: null,
    defender2TownHall: null,
    defender2Position: null,
    stars2: null,
    destructionPercentage2: null,
  };
}

function input(overrides: Partial<Parameters<typeof evaluateFwaWarMembersSourceEvidence>[0]> = {}) {
  const acceptedRows = Array.from({ length: 50 }, (_, index) => row(index + 1));
  const rawRows = acceptedRows.map((member) => ({
    tag: member.playerTag,
    name: member.playerName,
    position: member.position,
    townHall: member.townHall,
    weight: member.weight,
  }));
  return {
    clanTag: "#CLAN1",
    sourceUrl: "https://fwastats.com/Clan/CLAN1/WarMembers.json?warNo=1",
    sourceWarNo: 1,
    rawPayloadIsArray: true,
    rawRows,
    acceptedRows,
    observedAt: now,
    ingestedAt: now,
    declaredRosterSize: 50,
    declaredTotalWeight: acceptedRows.reduce((sum, member) => sum + (member.weight ?? 0), 0),
    ...overrides,
  };
}

describe("FWA WarMembers source evidence", () => {
  it("proves only structural facts and leaves exact-war authority unavailable", () => {
    const evidence = evaluateFwaWarMembersSourceEvidence(input());

    expect(evidence.structuralStatus).toBe("VERIFIED");
    expect(evidence.completenessStatus).toBe("VERIFIED");
    expect(evidence.weightStatus).toBe("VERIFIED");
    expect(evidence.exactWarBindingStatus).toBe("UNAVAILABLE");
    expect(evidence.sourceGenerationStatus).toBe("UNAVAILABLE");
    expect(evidence.candidateEligibilityStatus).toBe("UNAVAILABLE");
    expect(validateFwaWarMembersSourceEvidence(evidence)).toBe(true);
  });

  it("does not infer completeness from accepted row count after a discarded row", () => {
    const base = input();
    const rawRows = [...base.rawRows, { tag: "", name: "discarded", position: 51, weight: 181000 }];
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, rawRows });

    expect(evidence.acceptedRowCount).toBe(50);
    expect(evidence.rawRowCount).toBe(51);
    expect(evidence.discardedRowCount).toBe(1);
    expect(evidence.completenessStatus).toBe("UNAVAILABLE");
    expect(evidence.reasonCodes).toEqual(expect.arrayContaining(["discarded_row", "invalid_position"]));
  });

  it("rejects duplicate identities, duplicate positions and contradictory opponents", () => {
    const base = input();
    const acceptedRows = [...base.acceptedRows];
    acceptedRows[1] = { ...acceptedRows[1]!, playerTag: acceptedRows[0]!.playerTag, opponentTag: "#OPP2" };
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, acceptedRows });

    expect(evidence.weightStatus).toBe("CONFLICTING");
    expect(evidence.reasonCodes).toEqual(expect.arrayContaining([
      "duplicate_player_identity",
      "opponent_identity_conflict",
    ]));
  });

  it("rejects missing, negative and fractional raw weights", () => {
    const base = input();
    const rawRows = [...base.rawRows];
    rawRows[0] = { ...(rawRows[0] as object), weight: null };
    rawRows[1] = { ...(rawRows[1] as object), weight: -1 };
    rawRows[2] = { ...(rawRows[2] as object), weight: 181000.5 };
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, rawRows });

    expect(evidence.discardedRowCount).toBe(3);
    expect(evidence.reasonCodes).toEqual(expect.arrayContaining(["invalid_weight", "discarded_row"]));
    expect(evidence.candidateEligibilityStatus).toBe("CONFLICTING");
  });

  it("has an ordering-independent fingerprint and detects tampering", () => {
    const base = input();
    const first = evaluateFwaWarMembersSourceEvidence(base);
    const second = evaluateFwaWarMembersSourceEvidence({
      ...base,
      rawRows: [...base.rawRows].reverse(),
      acceptedRows: [...base.acceptedRows].reverse(),
    });

    expect(second.contentFingerprint).toBe(first.contentFingerprint);
    expect(validateFwaWarMembersSourceEvidence({ ...first, rawRowCount: 49 })).toBe(false);
  });
});
