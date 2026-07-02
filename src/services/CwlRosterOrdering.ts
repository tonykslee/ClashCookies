type CwlRosterOrderingKey = {
  familyRank: number;
  divisionRank: number;
  bracketRank: number;
};

export type CwlRosterOrderingEntry = {
  rosterTitle: string | null;
  leagueLabel: string | null;
  name: string | null;
  tag: string;
};

const CWL_ROSTER_FAMILY_RANK = new Map<string, number>([
  ["LEGEND", 7],
  ["CHAMPION", 6],
  ["MASTER", 5],
  ["CRYSTAL", 4],
  ["GOLD", 3],
  ["SILVER", 2],
  ["BRONZE", 1],
]);

const CWL_ROSTER_LEGEND_PATTERN = /^legend(?:\s+league)?$/i;
const CWL_ROSTER_STANDARD_PATTERN =
  /^(?<family>champion(?:s)?|master(?:s)?|crystal(?:s)?|gold(?:s)?|silver(?:s)?|bronze(?:s)?)(?:\s+league)?\s+(?<division>\d+|[ivxlcdm]+)(?:\s*\[\s*(?<bracket>[a-e])\s*\])?$/i;

function parseRomanNumeral(input: string): number | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const value = Math.trunc(Number(normalized));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const numerals = new Map([
    ["M", 1000],
    ["CM", 900],
    ["D", 500],
    ["CD", 400],
    ["C", 100],
    ["XC", 90],
    ["L", 50],
    ["XL", 40],
    ["X", 10],
    ["IX", 9],
    ["V", 5],
    ["IV", 4],
    ["I", 1],
  ]);
  let total = 0;
  let index = 0;
  while (index < normalized.length) {
    const pair = normalized.slice(index, index + 2);
    if (numerals.has(pair)) {
      total += numerals.get(pair) ?? 0;
      index += 2;
      continue;
    }
    const single = normalized[index] ?? "";
    if (!numerals.has(single)) return null;
    total += numerals.get(single) ?? 0;
    index += 1;
  }
  return total > 0 ? total : null;
}

function normalizeCwlRosterOrderingText(input: string | null | undefined): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function parseCwlRosterOrderingKey(input: string | null | undefined): CwlRosterOrderingKey | null {
  const normalized = normalizeCwlRosterOrderingText(input);
  if (!normalized) return null;

  const titleSegment = normalized.split("|", 1)[0]?.trim() ?? "";
  if (CWL_ROSTER_LEGEND_PATTERN.test(titleSegment)) {
    return {
      familyRank: CWL_ROSTER_FAMILY_RANK.get("LEGEND") ?? -1,
      divisionRank: 0,
      bracketRank: 0,
    };
  }

  const match = titleSegment.match(CWL_ROSTER_STANDARD_PATTERN);
  const familyToken = match?.groups?.family?.toUpperCase().replace(/S$/, "") ?? "";
  const familyRank = CWL_ROSTER_FAMILY_RANK.get(familyToken) ?? -1;
  if (familyRank < 0) return null;

  const divisionToken = match?.groups?.division?.trim() ?? "";
  const divisionRank = parseRomanNumeral(divisionToken);
  if (divisionRank === null || divisionRank < 1 || divisionRank > 3) return null;

  const bracketToken = match?.groups?.bracket?.trim().toUpperCase() ?? "";
  const bracketRank = bracketToken ? bracketToken.charCodeAt(0) - 64 : 0;
  if (bracketRank < 0 || bracketRank > 5) return null;

  return {
    familyRank,
    divisionRank,
    bracketRank,
  };
}

function compareCwlRosterOrderingKeys(
  left: CwlRosterOrderingKey | null,
  right: CwlRosterOrderingKey | null,
): number {
  const leftRank = left?.familyRank ?? -1;
  const rightRank = right?.familyRank ?? -1;
  if (leftRank !== rightRank) return rightRank - leftRank;

  const leftDivision = left?.divisionRank ?? Number.MAX_SAFE_INTEGER;
  const rightDivision = right?.divisionRank ?? Number.MAX_SAFE_INTEGER;
  if (leftDivision !== rightDivision) return leftDivision - rightDivision;

  const leftBracket = left?.bracketRank ?? Number.MAX_SAFE_INTEGER;
  const rightBracket = right?.bracketRank ?? Number.MAX_SAFE_INTEGER;
  if (leftBracket !== rightBracket) return leftBracket - rightBracket;

  return 0;
}

export function compareCwlRosterOrderingEntries(
  left: CwlRosterOrderingEntry,
  right: CwlRosterOrderingEntry,
): number {
  const leftSortKey =
    parseCwlRosterOrderingKey(left.rosterTitle) ?? parseCwlRosterOrderingKey(left.leagueLabel);
  const rightSortKey =
    parseCwlRosterOrderingKey(right.rosterTitle) ?? parseCwlRosterOrderingKey(right.leagueLabel);

  const plannedCompare = compareCwlRosterOrderingKeys(leftSortKey, rightSortKey);
  if (plannedCompare !== 0) return plannedCompare;

  const leftRosterTitle = normalizeCwlRosterOrderingText(left.rosterTitle);
  const rightRosterTitle = normalizeCwlRosterOrderingText(right.rosterTitle);
  const rosterTitleCompare = leftRosterTitle.localeCompare(rightRosterTitle, undefined, {
    sensitivity: "base",
  });
  if (rosterTitleCompare !== 0) return rosterTitleCompare;

  const leftName = normalizeCwlRosterOrderingText(left.name);
  const rightName = normalizeCwlRosterOrderingText(right.name);
  const nameCompare = leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
  if (nameCompare !== 0) return nameCompare;

  return String(left.tag ?? "").localeCompare(String(right.tag ?? ""), undefined, {
    sensitivity: "base",
  });
}
