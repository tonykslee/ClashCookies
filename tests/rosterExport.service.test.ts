import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { buildRosterExportRows, rosterExportService, ROSTER_EXPORT_HEADERS } from "../src/services/RosterExportService";
import { rosterService } from "../src/services/RosterService";

describe("RosterExportService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("builds roster export rows with the requested column order and fallback values", () => {
    const rows = buildRosterExportRows({
      roster: {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        maxMembers: null,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      } as any,
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 16,
          trophies: 7000,
          weight: 145000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T12:00:00.000Z"),
          discordDisplayName: "Alpha Display",
          discordUsername: "alpha-user",
          clanTag: "#2QG2C08UP",
          clanName: "Rising Crowns",
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
        {
          id: "signup-2",
          rosterId: "roster-1",
          groupId: "group-substitute",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 15,
          trophies: null,
          weight: 156000,
          weightSource: "Manual",
          weightMeasuredAt: new Date("2026-04-20T13:00:00.000Z"),
          discordDisplayName: null,
          discordUsername: null,
          clanTag: "#OTHER123",
          clanName: null,
          group: {
            id: "group-substitute",
            key: "substitute",
            name: "Substitute",
            description: "Reserve roster members",
            sortOrder: 1,
          },
        },
      ] as any,
      totalSignupCount: 2,
    } as any);

    expect(rows[0]).toEqual([...ROSTER_EXPORT_HEADERS]);
    expect(rows[1]).toEqual([
      "Alpha",
      "#PQL0289",
      "Yes",
      "Rising Crowns",
      "#2QG2C08UP",
      "alpha-user",
      "Confirmed",
      "145000",
      "FWA",
    ]);
    expect(rows[2]).toEqual([
      "Bravo",
      "#QGRJ2222",
      "No",
      "#OTHER123",
      "#OTHER123",
      "-",
      "Substitute",
      "156000",
      "Manual",
    ]);
  });

  it("exports deferment-winning roster weights and preserves the source label", () => {
    const rows = buildRosterExportRows({
      roster: {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        maxMembers: null,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      } as any,
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PL22CGC0",
          playerName: "Jess",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 18,
          trophies: 7000,
          weight: 178000,
          weightSource: "WeightInputDeferment",
          weightMeasuredAt: new Date("2026-04-10T12:00:00.000Z"),
          discordDisplayName: "Jess Display",
          discordUsername: "jess-user",
          clanTag: "#2QG2C08UP",
          clanName: "Cyklons",
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
      ] as any,
      totalSignupCount: 1,
    } as any);

    expect(rows[1]).toEqual([
      "Jess",
      "#PL22CGC0",
      "Yes",
      "Cyklons",
      "#2QG2C08UP",
      "jess-user",
      "Confirmed",
      "178000",
      "WeightInputDeferment",
    ]);
  });

  it("creates a public Google Sheet using the persisted roster view rows", async () => {
    vi.spyOn(rosterService, "getRosterView").mockResolvedValue({
      roster: {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        maxMembers: null,
        maxAccountsPerUser: null,
        minTownhall: null,
        maxTownhall: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        sortBy: null,
        displayColumns: null,
        importMembers: false,
        postButtonMode: "standard",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: null,
        updatedByDiscordUserId: null,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      } as any,
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 16,
          trophies: 7000,
          weight: 145000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T12:00:00.000Z"),
          discordDisplayName: null,
          discordUsername: "alpha-user",
          clanTag: "#2QG2C08UP",
          clanName: "Rising Crowns",
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
      ] as any,
      totalSignupCount: 1,
    } as any);

    const createSpreadsheetSpy = vi
      .spyOn(GoogleSheetsService.prototype, "createSpreadsheet")
      .mockResolvedValue({
        spreadsheetId: "sheet-1",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit?usp=sharing",
      });
    const writeSpreadsheetTabsSpy = vi
      .spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs")
      .mockResolvedValue(undefined);
    const makeSpreadsheetPublicSpy = vi
      .spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic")
      .mockResolvedValue(undefined);

    const result = await rosterExportService.createRosterExport({
      rosterId: "roster-1",
    });

    expect(result).toEqual({
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit?usp=sharing",
      tabName: "Roster Export",
      rowCount: 1,
    });
    expect(createSpreadsheetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "ClashCookies Roster Export - CWL Alpha Signup",
        tabNames: ["Roster Export"],
      }),
    );
    expect(writeSpreadsheetTabsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-1",
        tabs: [
          expect.objectContaining({
            tabName: "Roster Export",
            values: expect.arrayContaining([
              [...ROSTER_EXPORT_HEADERS],
              [
                "Alpha",
                "#PQL0289",
                "Yes",
                "Rising Crowns",
                "#2QG2C08UP",
                "alpha-user",
                "Confirmed",
                "145000",
                "FWA",
              ],
            ]),
          }),
        ],
      }),
    );
    expect(makeSpreadsheetPublicSpy).toHaveBeenCalledWith("sheet-1");
  });
});
