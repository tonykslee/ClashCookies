import { describe, expect, it } from "vitest";

import {
  buildFwaMatchCompactCopyLineForTest,
  buildFwaMatchCompactCopyStateEmojiForTest,
} from "../src/commands/Fwa";

describe("fwa match compact copy view", () => {
  it.each([
    { matchType: "BL" as const, outcome: null, expected: "⚫" },
    { matchType: "MM" as const, outcome: null, expected: "⚪" },
    { matchType: "FWA" as const, outcome: "WIN" as const, expected: "🟢" },
    { matchType: "FWA" as const, outcome: "LOSE" as const, expected: "🔴" },
    { matchType: "UNKNOWN" as const, outcome: null, expected: "◯" },
  ])("maps %s/%s to the expected compact state emoji", ({ matchType, outcome, expected }) => {
    expect(
      buildFwaMatchCompactCopyStateEmojiForTest({
        matchType,
        outcome,
      })
    ).toBe(expected);
  });

  it.each([
    {
      mailStatusEmoji: "📬",
      matchType: "FWA" as const,
      outcome: "WIN" as const,
      clanName: "Alpha",
      opponentName: "Bravo",
      opponentTag: "#OPP456",
      expected: "📬 | 🟢 | Alpha vs `Bravo` (`#OPP456`)",
    },
    {
      mailStatusEmoji: "📭",
      matchType: "FWA" as const,
      outcome: "LOSE" as const,
      clanName: "Alpha",
      opponentName: "Bravo",
      opponentTag: "OPP456",
      expected: "📭 | 🔴 | Alpha vs `Bravo` (`#OPP456`)",
    },
    {
      mailStatusEmoji: "📬",
      matchType: "BL" as const,
      outcome: null,
      clanName: "Alpha",
      opponentName: "Bravo",
      opponentTag: "#OPP456",
      expected: "📬 | ⚫ | Alpha vs `Bravo` (`#OPP456`)",
    },
    {
      mailStatusEmoji: "📭",
      matchType: "MM" as const,
      outcome: null,
      clanName: "Alpha",
      opponentName: "Bravo",
      opponentTag: "#OPP456",
      expected: "📭 | ⚪ | Alpha vs `Bravo` (`#OPP456`)",
    },
    {
      mailStatusEmoji: "📬",
      matchType: "UNKNOWN" as const,
      outcome: null,
      clanName: "Alpha",
      opponentName: "Bravo",
      opponentTag: "#OPP456",
      expected: "📬 | ◯ | Alpha vs `Bravo` (`#OPP456`)",
    },
    {
      mailStatusEmoji: "📭",
      matchType: "FWA" as const,
      outcome: null,
      clanName: "Al`pha",
      opponentName: "Br`avo",
      opponentTag: "#OP`P456",
      expected: "📭 | ◯ | Al'pha vs `Br'avo` (`#OP'P456`)",
    },
    {
      mailStatusEmoji: "📬",
      matchType: "UNKNOWN" as const,
      outcome: null,
      clanName: "Alpha",
      opponentName: null,
      opponentTag: null,
      expected: "📬 | ◯ | Alpha vs `unknown` (`—`)",
    },
  ])("renders compact copy rows for %s", (input) => {
    expect(buildFwaMatchCompactCopyLineForTest(input)).toBe(input.expected);
  });

  it("renders alliance overview copy as compact one-line-per-clan rows", () => {
    const lines = [
      buildFwaMatchCompactCopyLineForTest({
        mailStatusEmoji: "📬",
        matchType: "FWA",
        outcome: "WIN",
        clanName: "Alpha",
        opponentName: "Bravo",
        opponentTag: "#B1",
      }),
      buildFwaMatchCompactCopyLineForTest({
        mailStatusEmoji: "📭",
        matchType: "MM",
        outcome: null,
        clanName: "Charlie",
        opponentName: "Delta",
        opponentTag: "#D2",
      }),
    ];

    expect(lines.join("\n")).toBe(
      "📬 | 🟢 | Alpha vs `Bravo` (`#B1`)\n📭 | ⚪ | Charlie vs `Delta` (`#D2`)"
    );
  });

  it("renders single-clan copy as one compact row", () => {
    const line = buildFwaMatchCompactCopyLineForTest({
      mailStatusEmoji: "📭",
      matchType: "BL",
      outcome: null,
      clanName: "Echo",
      opponentName: "Foxtrot",
      opponentTag: "#F3",
    });

    expect(line).toBe("📭 | ⚫ | Echo vs `Foxtrot` (`#F3`)");
    expect(line.includes("\n")).toBe(false);
  });
});
