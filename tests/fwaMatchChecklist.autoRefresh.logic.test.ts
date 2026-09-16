import { describe, expect, it } from "vitest";
import {
  areFwaMatchChecklistRowsEqual,
  assessFwaMatchChecklistCompletion,
  parseFwaMatchChecklistMetadata,
} from "../src/services/TrackedMessageService";

function row(overrides: Record<string, unknown> = {}) {
  return {
    clanTag: "#PYPY",
    compactCopyLine: "RR | 🟢 | #OPP | FWA-WIN",
    badgeEmojiId: "111",
    badgeEmojiName: "rr",
    badgeEmojiInline: "<:rr:111>",
    matchType: "FWA" as const,
    matchStateInferred: false,
    outcome: "WIN" as const,
    warId: 123,
    opponentTag: "#OPP",
    warStartTimeIso: "2026-05-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("FWA checklist automatic-refresh typed logic", () => {
  it("requires complete expected coverage and resolved FWA outcomes", () => {
    expect(
      assessFwaMatchChecklistCompletion({
        rows: [row()],
        expectedTrackedClanTags: ["#PYPY", "#PYPL"],
      }),
    ).toMatchObject({ complete: false, unresolvedCount: 1 });
    expect(
      assessFwaMatchChecklistCompletion({
        rows: [row({ outcome: "UNKNOWN" })],
        expectedTrackedClanTags: ["#PYPY"],
      }),
    ).toMatchObject({ complete: false, unresolvedCount: 1 });
    expect(
      assessFwaMatchChecklistCompletion({
        rows: [row({ outcome: "WIN", matchStateInferred: true })],
        expectedTrackedClanTags: ["#PYPY"],
      }),
    ).toMatchObject({ complete: true, unresolvedCount: 0 });
  });

  it("treats BL and MM as resolved without an outcome", () => {
    expect(
      assessFwaMatchChecklistCompletion({
        rows: [row({ matchType: "BL", outcome: null }), row({ clanTag: "#PYPL", matchType: "MM", outcome: null })],
        expectedTrackedClanTags: ["#PYPY", "#PYPL"],
      }),
    ).toMatchObject({ complete: true, unresolvedCount: 0 });
  });

  it("rejects missing or placeholder opponents and preserves automatic metadata", () => {
    expect(
      assessFwaMatchChecklistCompletion({
        rows: [row({ opponentTag: "-" })],
        expectedTrackedClanTags: ["#PYPY"],
      }),
    ).toMatchObject({ complete: false });

    const parsed = parseFwaMatchChecklistMetadata({
      kind: "mail_checklist",
      createdByUserId: "system",
      createdAtIso: "2026-05-13T00:00:00.000Z",
      expectedTrackedClanTags: ["#PYPY"],
      autoRefreshLastAttemptAtIso: "2026-05-13T00:15:00.000Z",
      autoRefreshCompletedAtIso: null,
      rows: [row()],
    });
    expect(parsed).toMatchObject({
      expectedTrackedClanTags: ["#PYPY"],
      autoRefreshLastAttemptAtIso: "2026-05-13T00:15:00.000Z",
      autoRefreshCompletedAtIso: null,
    });
  });

  it("compares typed render state without treating reaction acknowledgments as changes", () => {
    const current = row();
    expect(areFwaMatchChecklistRowsEqual([current], [{ ...current }])).toBe(true);
    expect(
      areFwaMatchChecklistRowsEqual([current], [row({ outcome: "LOSE" })]),
    ).toBe(false);
  });
});
