import { describe, expect, it } from "vitest";
import {
  computeFwaWarMembersSourceEvidenceContentFingerprint,
  evaluateFwaWarMembersSourceEvidence,
  validateFwaWarMembersSourceEvidence,
} from "../src/services/fwa-feeds/FwaWarMembersSourceEvidence";
import type { FwaWarMemberFeedRow } from "../src/services/fwa-feeds/types";

const now = new Date("2026-11-21T12:00:00.000Z");

function row(position: number, weight = 181000): FwaWarMemberFeedRow {
  return {
    clanTag: "#CLAN1", playerTag: `#PLAYER${position}`, playerName: `Player ${position}`, position, townHall: 19, weight,
    opponentTag: "#0PP1", opponentName: "Opponent", attacks: 0, defender1Tag: null, defender1Name: null,
    defender1TownHall: null, defender1Position: null, stars1: null, destructionPercentage1: null,
    defender2Tag: null, defender2Name: null, defender2TownHall: null, defender2Position: null, stars2: null,
    destructionPercentage2: null,
  };
}

function rawFromRow(member: FwaWarMemberFeedRow): Record<string, unknown> {
  return { tag: member.playerTag, name: member.playerName, position: member.position, townHall: member.townHall, weight: member.weight, opponentTag: member.opponentTag, opponentName: member.opponentName, attacks: member.attacks };
}

function input(overrides: Partial<Parameters<typeof evaluateFwaWarMembersSourceEvidence>[0]> = {}) {
  const acceptedRows = Array.from({ length: 50 }, (_, index) => row(index + 1));
  return {
    clanTag: "#CLAN1", sourceUrl: "https://fwastats.com/Clan/CLAN1/WarMembers.json?warNo=1", sourceWarNo: 1,
    rawPayloadIsArray: true, rawRows: acceptedRows.map(rawFromRow), acceptedRows, observedAt: now, ingestedAt: now,
    declaredRosterSize: 50, declaredTotalWeight: acceptedRows.reduce((sum, member) => sum + (member.weight ?? 0), 0), ...overrides,
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
    expect(evidence.parserAcceptedRowCount).toBe(50);
    expect(evidence.evidenceEligibleRowCount).toBe(50);
    expect(validateFwaWarMembersSourceEvidence(evidence)).toBe(true);
  });

  it("derives facts from raw rows instead of trusting one raw row plus fabricated accepted rows", () => {
    const base = input();
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, rawRows: [base.rawRows[0]!], acceptedRows: base.acceptedRows });
    expect(evidence.rawRowCount).toBe(1);
    expect(evidence.parserAcceptedRowCount).toBe(1);
    expect(evidence.acceptedRowCount).toBe(1);
    expect(evidence.reasonCodes).toContain("accepted_rows_mismatch");
    expect(evidence.candidateEligibilityStatus).toBe("CONFLICTING");
    expect(validateFwaWarMembersSourceEvidence(evidence)).toBe(true);
  });

  it("rejects same-size accepted projections with different identities or positions", () => {
    const base = input();
    const fabricatedAcceptedRows = base.acceptedRows.map((member, index) => index === 0 ? { ...member, playerTag: "#OTHER", position: 50 } : member);
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, acceptedRows: fabricatedAcceptedRows });
    expect(evidence.parserAcceptedRowCount).toBe(50);
    expect(evidence.reasonCodes).toContain("accepted_rows_mismatch");
    expect(evidence.structuralStatus).toBe("CONFLICTING");
    expect(evidence.candidateEligibilityStatus).toBe("CONFLICTING");
  });

  it("keeps parser-accepted rows distinct from evidence-ineligible invalid weights", () => {
    const base = input();
    const rawRows = [...base.rawRows];
    rawRows[0] = { ...rawRows[0]!, weight: null };
    rawRows[1] = { ...rawRows[1]!, weight: -1 };
    rawRows[2] = { ...rawRows[2]!, weight: 181000.5 };
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, rawRows, acceptedRows: undefined });
    expect(evidence.parserAcceptedRowCount).toBe(50);
    expect(evidence.parserRejectedRowCount).toBe(0);
    expect(evidence.discardedRowCount).toBe(0);
    expect(evidence.evidenceIneligibleRowCount).toBe(3);
    expect(evidence.reasonCodes).toEqual(expect.arrayContaining(["invalid_weight", "evidence_ineligible"]));
    expect(evidence.weightStatus).toBe("CONFLICTING");
    expect(evidence.candidateEligibilityStatus).toBe("CONFLICTING");
  });

  it("records parser-rejected malformed rows separately", () => {
    const evidence = evaluateFwaWarMembersSourceEvidence(input({ rawRows: [null, { tag: "", name: "Unparseable", position: 1, weight: 181000 }], acceptedRows: undefined, declaredRosterSize: null, declaredTotalWeight: null }));
    expect(evidence.parserAcceptedRowCount).toBe(0);
    expect(evidence.parserRejectedRowCount).toBe(2);
    expect(evidence.discardedRowCount).toBe(2);
    expect(evidence.evidenceIneligibleRowCount).toBe(2);
    expect(evidence.reasonCodes).toEqual(expect.arrayContaining(["parser_rejected", "discarded_row", "malformed_row", "missing_player_identity"]));
  });

  it("distinguishes missing declared proof from declared mismatches", () => {
    const missing = evaluateFwaWarMembersSourceEvidence(input({ declaredRosterSize: null, declaredTotalWeight: null }));
    expect(missing.structuralStatus).toBe("VERIFIED");
    expect(missing.completenessStatus).toBe("UNAVAILABLE");
    expect(missing.weightStatus).toBe("UNAVAILABLE");
    expect(missing.candidateEligibilityStatus).toBe("UNAVAILABLE");
    const mismatch = evaluateFwaWarMembersSourceEvidence(input({ declaredRosterSize: 49, declaredTotalWeight: 1 }));
    expect(mismatch.completenessStatus).toBe("CONFLICTING");
    expect(mismatch.weightStatus).toBe("CONFLICTING");
    expect(mismatch.reasonCodes).toEqual(expect.arrayContaining(["roster_size_mismatch", "total_weight_mismatch"]));
  });

  it("rejects duplicate players/positions and contradictory opponents", () => {
    const base = input();
    const rawRows = [...base.rawRows];
    rawRows[1] = { ...rawRows[1]!, tag: rawRows[0]!.tag, position: rawRows[0]!.position, opponentTag: "#OPP2" };
    const evidence = evaluateFwaWarMembersSourceEvidence({ ...base, rawRows, acceptedRows: undefined });
    expect(evidence.reasonCodes).toEqual(expect.arrayContaining(["duplicate_player_identity", "duplicate_position", "opponent_identity_conflict"]));
    expect(evidence.weightStatus).toBe("CONFLICTING");
    expect(evidence.candidateEligibilityStatus).toBe("CONFLICTING");
  });

  it("rejects forged VERIFIED authority even when its checksum is recomputed", () => {
    const evidence = evaluateFwaWarMembersSourceEvidence(input());
    const { contentFingerprint: _old, ...payload } = evidence;
    const forgedPayload = { ...payload, exactWarBindingStatus: "VERIFIED" as const };
    const forged = { ...forgedPayload, contentFingerprint: computeFwaWarMembersSourceEvidenceContentFingerprint(forgedPayload) };
    expect(validateFwaWarMembersSourceEvidence(forged)).toBe(false);
  });

  it("keeps equivalent source content fingerprints order-independent", () => {
    const base = input();
    const first = evaluateFwaWarMembersSourceEvidence(base);
    const second = evaluateFwaWarMembersSourceEvidence({ ...base, rawRows: [...base.rawRows].reverse(), acceptedRows: [...base.acceptedRows].reverse() });
    expect(second.contentFingerprint).toBe(first.contentFingerprint);
    expect(second.rawPayloadFingerprint).toBe(first.rawPayloadFingerprint);
    expect(second.acceptedRowsFingerprint).toBe(first.acceptedRowsFingerprint);
    expect(validateFwaWarMembersSourceEvidence(second)).toBe(true);
    expect(validateFwaWarMembersSourceEvidence({ ...first, rawRowCount: 49 })).toBe(false);
  });
});
