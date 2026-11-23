import { describe, expect, it, vi } from "vitest";
import {
  captureFwaWarMembersObservation,
  computeFwaWarMembersRosterFingerprint,
} from "../src/services/fwa-feeds/FwaWarMembersObservationService";
import { evaluateFwaWarMembersSourceEvidence } from "../src/services/fwa-feeds/FwaWarMembersSourceEvidence";
import type { FwaWarMemberFeedRow } from "../src/services/fwa-feeds/types";

function row(position: number, weight: number | null = 181000): FwaWarMemberFeedRow {
  return {
    clanTag: "#CLAN1",
    playerTag: `#PLAYER${position}`,
    playerName: `Player ${position}`,
    position,
    townHall: 19,
    weight,
    opponentTag: "#0PP1",
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

function evidenceFor(rows: readonly FwaWarMemberFeedRow[]) {
  return evaluateFwaWarMembersSourceEvidence({
    clanTag: "#CLAN1",
    sourceUrl: "https://fwastats.com/Clan/CLAN1/WarMembers.json?warNo=1",
    sourceWarNo: 1,
    rawPayloadIsArray: true,
    rawRows: rows.map((member) => ({
      tag: member.playerTag,
      name: member.playerName,
      position: member.position,
      townHall: member.townHall,
      weight: member.weight,
      opponentTag: member.opponentTag,
      opponentName: member.opponentName,
      attacks: member.attacks,
    })),
    acceptedRows: rows,
    observedAt: new Date("2026-11-23T12:00:00.000Z"),
    ingestedAt: new Date("2026-11-23T12:00:01.000Z"),
  });
}

describe("FWA WarMembers observations", () => {
  it("uses only semantic roster fields for an order-independent fingerprint", () => {
    const first = row(1);
    const changedAttack = { ...first, attacks: 2 };
    expect(computeFwaWarMembersRosterFingerprint("clan1", [first, row(2)])).toBe(
      computeFwaWarMembersRosterFingerprint("#CLAN1", [row(2), changedAttack]),
    );
    expect(computeFwaWarMembersRosterFingerprint("#CLAN1", [first, row(2)])).not.toBe(
      computeFwaWarMembersRosterFingerprint("#CLAN1", [row(2), { ...first, weight: 0 }]),
    );
  });

  it("persists one immutable envelope and member rows with duplicate-safe writes", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
    const evidence = evidenceFor(rows);
    const upsert = vi.fn().mockResolvedValue({ id: "observation-1" });
    const createMany = vi.fn().mockResolvedValue({ count: 50 });
    const db = {
      fwaWarMembersObservation: { upsert },
      fwaWarMembersObservationMember: { createMany },
    } as never;

    const result = await captureFwaWarMembersObservation(db, { clanTag: "#CLAN1", rows, evidence });

    expect(result.rosterCompletenessStatus).toBe("COMPLETE");
    expect(result.weightQualityStatus).toBe("DIRECT_PRESENT");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { clanTag_rosterFingerprint: expect.objectContaining({ clanTag: "#CLAN1" }) },
      update: {},
    }));
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Array),
      skipDuplicates: true,
    }));
    expect(createMany.mock.calls[0][0].data).toHaveLength(50);
  });

  it("retains zero direct weights as missing quality, not malformed evidence", () => {
    const evidence = evidenceFor([row(1, 0)]);
    expect(evidence.reasonCodes).not.toContain("invalid_weight");
    expect(evidence.structuralStatus).toBe("VERIFIED");
    expect(evidence.weightStatus).toBe("UNAVAILABLE");
  });

  it("keeps incomplete and malformed observations distinguishable", async () => {
    const rows = [row(1), { ...row(2), position: 1 }];
    const evidence = evidenceFor(rows);
    const upsert = vi.fn().mockResolvedValue({ id: "observation-2" });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const result = await captureFwaWarMembersObservation({
      fwaWarMembersObservation: { upsert },
      fwaWarMembersObservationMember: { createMany },
    } as never, { clanTag: "#CLAN1", rows, evidence });
    expect(result.rosterCompletenessStatus).toBe("CONFLICTING");
    expect(upsert.mock.calls[0][0].create.sourceQualityReasonCodes).toEqual(
      expect.arrayContaining(["duplicate_position"]),
    );
  });

  it("propagates member persistence failures so the owning feed transaction can roll back", async () => {
    const rows = [row(1)];
    const createMany = vi.fn().mockRejectedValue(new Error("member write failed"));
    await expect(captureFwaWarMembersObservation({
      fwaWarMembersObservation: { upsert: vi.fn().mockResolvedValue({ id: "observation-failure" }) },
      fwaWarMembersObservationMember: { createMany },
    } as never, { clanTag: "#CLAN1", rows, evidence: evidenceFor(rows) })).rejects.toThrow("member write failed");
  });

  it("uses the same unique parent and duplicate-safe member contract for concurrent retries", async () => {
    const rows = [row(1), row(2)];
    const upsert = vi.fn().mockResolvedValue({ id: "observation-concurrent" });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = {
      fwaWarMembersObservation: { upsert },
      fwaWarMembersObservationMember: { createMany },
    } as never;
    const [first, second] = await Promise.all([
      captureFwaWarMembersObservation(db, { clanTag: "#CLAN1", rows, evidence: evidenceFor(rows) }),
      captureFwaWarMembersObservation(db, { clanTag: "#CLAN1", rows: [...rows].reverse(), evidence: evidenceFor([...rows].reverse()) }),
    ]);
    expect(first.rosterFingerprint).toBe(second.rosterFingerprint);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls.every((call) => call[0].skipDuplicates === true)).toBe(true);
  });
});
