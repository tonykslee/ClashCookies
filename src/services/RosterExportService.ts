import { GoogleSheetsService } from "./GoogleSheetsService";
import { rosterService, type RosterSignupView } from "./RosterService";
import { SettingsService } from "./SettingsService";
import { normalizeClanTag } from "./PlayerLinkService";

export const ROSTER_EXPORT_TAB_NAME = "Roster Export";
export const ROSTER_EXPORT_HEADERS = [
  "Player Name",
  "Player Tag",
  "In Clan?",
  "Current Clan",
  "Current ClanTag",
  "Discord",
  "Group",
  "Weight",
  "Weight Source",
] as const;

export type RosterExportResult = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  tabName: string;
  rowCount: number;
};

function formatRosterExportCell(value: string | number | null | undefined): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "-";
}

export function buildRosterExportRows(view: RosterSignupView): string[][] {
  const rosterClanTag = normalizeClanTag(view.roster.clanTag ?? "");
  const rows: string[][] = [Array.from(ROSTER_EXPORT_HEADERS) as string[]];

  for (const signup of view.signups) {
    const signupClanTag = normalizeClanTag(signup.clanTag ?? "");
    const inClan = rosterClanTag && signupClanTag && rosterClanTag === signupClanTag ? "Yes" : "No";
    rows.push([
      formatRosterExportCell(signup.playerName ?? signup.playerTag),
      formatRosterExportCell(signup.playerTag),
      inClan,
      formatRosterExportCell(signup.clanName ?? signup.clanTag),
      formatRosterExportCell(signup.clanTag),
      formatRosterExportCell(signup.discordUsername),
      formatRosterExportCell(signup.group?.name ?? signup.group?.key),
      formatRosterExportCell(signup.weight),
      formatRosterExportCell(signup.weightSource),
    ]);
  }

  return rows;
}

export class RosterExportService {
  constructor(
    private readonly roster = rosterService,
    private readonly sheets = new GoogleSheetsService(new SettingsService()),
  ) {}

  async createRosterExport(input: { rosterId: string }): Promise<RosterExportResult | null> {
    const view = await this.roster.getRosterView(String(input.rosterId ?? "").trim());
    if (!view) {
      return null;
    }

    const values = buildRosterExportRows(view);
    const spreadsheet = await this.sheets.createSpreadsheet({
      title: `ClashCookies Roster Export - ${view.roster.title}`,
      tabNames: [ROSTER_EXPORT_TAB_NAME],
    });
    await this.sheets.writeSpreadsheetTabs({
      spreadsheetId: spreadsheet.spreadsheetId,
      tabs: [
        {
          tabName: ROSTER_EXPORT_TAB_NAME,
          values,
        },
      ],
    });
    await this.sheets.makeSpreadsheetPublic(spreadsheet.spreadsheetId);

    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      spreadsheetUrl: spreadsheet.spreadsheetUrl,
      tabName: ROSTER_EXPORT_TAB_NAME,
      rowCount: Math.max(0, values.length - 1),
    };
  }
}

export const rosterExportService = new RosterExportService();
