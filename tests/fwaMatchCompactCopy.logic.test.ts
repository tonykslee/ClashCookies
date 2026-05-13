import { EmbedBuilder } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  buildFwaMatchCompactCopyLineForTest,
  buildFwaMatchCompactCopyStateEmojiForTest,
  buildFwaMatchViewRenderPayload,
} from "../src/commands/Fwa";

function makeView(copyText: string, title: string) {
  return {
    embed: new EmbedBuilder().setTitle(title).setDescription(title),
    copyText,
  };
}

function makePayload(allianceCopyText: string, singleCopyText: string) {
  const allianceView = makeView(allianceCopyText, "Alliance");
  const singleView = makeView(singleCopyText, "Single");
  return {
    userId: "111111111111111111",
    guildId: "guild-1",
    includePostButton: true,
    allianceView,
    allianceViewIsScoped: false,
    singleViews: {
      ABC123: singleView,
    },
    currentScope: "alliance" as const,
    currentTag: null,
    revisionDraftByTag: {},
  };
}

describe("fwa match compact copy view", () => {
  it.each([
    { matchType: "BL" as const, outcome: null, expected: "⚫" },
    { matchType: "MM" as const, outcome: null, expected: "⚪" },
    { matchType: "FWA" as const, outcome: "WIN" as const, expected: "🟢" },
    { matchType: "FWA" as const, outcome: "LOSE" as const, expected: "🔴" },
    { matchType: "UNKNOWN" as const, outcome: null, expected: "🔘" },
  ])("maps %s/%s to the expected compact state emoji", ({ matchType, outcome, expected }) => {
    expect(
      buildFwaMatchCompactCopyStateEmojiForTest({
        matchType,
        outcome,
      }),
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
      expected: "📬 | 🔘 | Alpha vs `Bravo` (`#OPP456`)",
    },
    {
      mailStatusEmoji: "📭",
      matchType: "FWA" as const,
      outcome: null,
      clanName: "Al`pha",
      opponentName: "Br`avo",
      opponentTag: "#OP`P456",
      expected: "📭 | 🔘 | Al'pha vs `Br'avo` (`#OP'P456`)",
    },
    {
      mailStatusEmoji: "📬",
      matchType: "UNKNOWN" as const,
      outcome: null,
      clanName: "Alpha",
      opponentName: null,
      opponentTag: null,
      expected: "📬 | 🔘 | Alpha vs `unknown` (`—`)",
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
      "📬 | 🟢 | Alpha vs `Bravo` (`#B1`)\n📭 | ⚪ | Charlie vs `Delta` (`#D2`)",
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

  it("renders normal match embed by default and direct copy_paste without components", () => {
    const payload = makePayload(
      "📬 | 🟢 | Alliance vs `Bravo` (`#B1`)",
      "📬 | ⚫ | Single vs `Delta` (`#D2`)",
    );

    const embedResponse = buildFwaMatchViewRenderPayload({
      payload,
      key: "key-1",
      view: payload.allianceView as any,
      showMode: "embed",
    });
    expect(embedResponse.content).toBeUndefined();
    expect(embedResponse.embeds).toHaveLength(1);
    expect(embedResponse.components.length).toBeGreaterThan(0);

    const copyResponse = buildFwaMatchViewRenderPayload({
      payload,
      key: "key-1",
      view: payload.allianceView as any,
      showMode: "copy",
      includeComponents: false,
    });
    expect(copyResponse.content).toBe(payload.allianceView.copyText);
    expect(copyResponse.embeds).toHaveLength(0);
    expect(copyResponse.components).toHaveLength(0);
  });

  it("renders alliance and single-clan copy_paste output with the same copy text shape as the button view", () => {
    const payload = makePayload(
      "📬 | 🟢 | Alliance vs `Bravo` (`#B1`)",
      "📭 | 🔴 | Single vs `Delta` (`#D2`)",
    );

    const allianceButtonView = buildFwaMatchViewRenderPayload({
      payload,
      key: "key-2",
      view: payload.allianceView as any,
      showMode: "copy",
    });
    const allianceDirectView = buildFwaMatchViewRenderPayload({
      payload,
      key: "key-2",
      view: payload.allianceView as any,
      showMode: "copy",
      includeComponents: false,
    });
    expect(allianceDirectView.content).toBe(allianceButtonView.content);
    expect(allianceButtonView.components.length).toBeGreaterThan(0);
    expect(allianceDirectView.components).toHaveLength(0);

    const singleButtonView = buildFwaMatchViewRenderPayload({
      payload,
      key: "key-3",
      view: payload.singleViews.ABC123 as any,
      showMode: "copy",
    });
    const singleDirectView = buildFwaMatchViewRenderPayload({
      payload,
      key: "key-3",
      view: payload.singleViews.ABC123 as any,
      showMode: "copy",
      includeComponents: false,
    });
    expect(singleDirectView.content).toBe(singleButtonView.content);
    expect(singleButtonView.components.length).toBeGreaterThan(0);
    expect(singleDirectView.components).toHaveLength(0);
  });
});
