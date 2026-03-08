import { describe, expect, it } from "vitest";
import {
  extractActiveFwa,
  extractMatchupBalances,
  extractMatchupHeader,
  extractPointBalance,
  extractTagsFromText,
  parseCocApiTime,
  sanitizeClanName,
} from "../src/commands/fwa/dataParsers";

describe("fwa data parsers", () => {
  it("extracts point balance from html content", () => {
    const html = "<div><strong>Current Point Balance: 12345</strong></div>";
    expect(extractPointBalance(html)).toBe(12345);
  });

  it("extracts active FWA values across text candidates", () => {
    expect(extractActiveFwa("Active FWA: Yes")).toBe(true);
    expect(extractActiveFwa("Active FWA: No")).toBe(false);
    expect(extractActiveFwa("No matching field")).toBeNull();
  });

  it("parses matchup header and sync number", () => {
    const header = extractMatchupHeader("Sync #74 Alpha (Q2AAA) vs. Bravo (P3BBB)");
    expect(header).toEqual({
      syncNumber: 74,
      primaryName: "Alpha",
      primaryTag: "Q2AAA",
      opponentName: "Bravo",
      opponentTag: "P3BBB",
    });
  });

  it("extracts tags and matchup balances from summary text", () => {
    const text = "Winner: #Q2AAA (Q2AAA) (1200 > 1180, high sync)";
    expect(extractTagsFromText(text)).toEqual(["Q2AAA"]);
    expect(extractMatchupBalances(text)).toEqual({
      primaryBalance: 1200,
      opponentBalance: 1180,
    });
  });

  it("parses Clash API timestamps to epoch milliseconds", () => {
    expect(parseCocApiTime("20260308T123456.000Z")).toBe(
      Date.UTC(2026, 2, 8, 12, 34, 56)
    );
  });

  it("sanitizes noisy clan names", () => {
    expect(sanitizeClanName("Clan Tag: #ABC")).toBeNull();
    expect(sanitizeClanName("  Legit Clan  ")).toBe("Legit Clan");
  });
});
