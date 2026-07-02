import { describe, expect, it } from "vitest";
import { compareCwlRosterOrderingEntries, type CwlRosterOrderingEntry } from "../src/services/CwlRosterOrdering";

function sortEntries(entries: CwlRosterOrderingEntry[]): CwlRosterOrderingEntry[] {
  return [...entries].sort(compareCwlRosterOrderingEntries);
}

describe("CwlRosterOrdering", () => {
  it("orders Legend above Champion, Champion above Masters 1 and Masters 2, and Crystal below Master across numeric and Roman numeral forms", () => {
    const ordered: CwlRosterOrderingEntry[] = [
      { rosterTitle: "Legend League | Showcase", leagueLabel: null, name: "Legend Clan", tag: "#1" },
      { rosterTitle: "Champion 3 | Serious CWL", leagueLabel: null, name: "Champion Clan", tag: "#2" },
      { rosterTitle: "Masters 1 [A] | TH18 175k+", leagueLabel: null, name: "Master A", tag: "#3" },
      { rosterTitle: "Masters I [B] | TH18 175k+", leagueLabel: null, name: "Master B", tag: "#4" },
      { rosterTitle: "Masters 1 [C] | TH18 175k+", leagueLabel: null, name: "Master C", tag: "#5" },
      { rosterTitle: "Masters II [A] | TH17 - 18", leagueLabel: null, name: "Master 2A", tag: "#6" },
      { rosterTitle: "Masters 2 [B] | TH17 - 18", leagueLabel: null, name: "Master 2B", tag: "#7" },
      { rosterTitle: "Crystal 1 | TH13 and below", leagueLabel: null, name: "Crystal Clan", tag: "#8" },
    ];

    expect(sortEntries([...ordered].reverse())).toEqual(ordered);
  });

  it("falls back to leagueLabel for missing or malformed roster titles and keeps unknown entries at the end", () => {
    const rows: CwlRosterOrderingEntry[] = [
      { rosterTitle: null, leagueLabel: "Crystal League I", name: "Crystal Fallback", tag: "#5" },
      { rosterTitle: "Not a CWL roster", leagueLabel: "Master League II", name: "Master Fallback", tag: "#3" },
      { rosterTitle: null, leagueLabel: null, name: "Alpha Unknown", tag: "#9" },
      { rosterTitle: "Broken Roster", leagueLabel: "Unknown", name: "Beta Unknown", tag: "#1" },
    ];

    expect(sortEntries(rows)).toEqual([
      { rosterTitle: "Not a CWL roster", leagueLabel: "Master League II", name: "Master Fallback", tag: "#3" },
      { rosterTitle: null, leagueLabel: "Crystal League I", name: "Crystal Fallback", tag: "#5" },
      { rosterTitle: null, leagueLabel: null, name: "Alpha Unknown", tag: "#9" },
      { rosterTitle: "Broken Roster", leagueLabel: "Unknown", name: "Beta Unknown", tag: "#1" },
    ]);
  });

  it("applies roster-title, clan-name, and clan-tag tie-breakers deterministically", () => {
    const rows: CwlRosterOrderingEntry[] = [
      { rosterTitle: "Masters 1 [A] | Beta", leagueLabel: null, name: "Bravo Clan", tag: "#C" },
      { rosterTitle: "Masters 1 [A] | Alpha", leagueLabel: null, name: "Zulu Clan", tag: "#Z" },
      { rosterTitle: "Masters 1 [A] | Beta", leagueLabel: null, name: "Alpha Clan", tag: "#C" },
      { rosterTitle: "Masters 1 [A] | Beta", leagueLabel: null, name: "Alpha Clan", tag: "#A" },
    ];

    expect(sortEntries(rows)).toEqual([
      { rosterTitle: "Masters 1 [A] | Alpha", leagueLabel: null, name: "Zulu Clan", tag: "#Z" },
      { rosterTitle: "Masters 1 [A] | Beta", leagueLabel: null, name: "Alpha Clan", tag: "#A" },
      { rosterTitle: "Masters 1 [A] | Beta", leagueLabel: null, name: "Alpha Clan", tag: "#C" },
      { rosterTitle: "Masters 1 [A] | Beta", leagueLabel: null, name: "Bravo Clan", tag: "#C" },
    ]);
  });
});
