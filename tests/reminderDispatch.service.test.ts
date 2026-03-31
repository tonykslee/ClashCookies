import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderType } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { buildReminderDispatchEmbedsForTest } from "../src/services/reminders/ReminderDispatchService";

describe("ReminderDispatchService roster rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
  });

  it("renders WAR remaining-attacks roster with position sort and linked/unlinked formats", async () => {
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      { playerTag: "#PYLG", playerName: "Bravo", position: 2, attacks: 1 },
      { playerTag: "#PYLQ", playerName: "Alpha", position: 1, attacks: 0 },
      { playerTag: "#PYLR", playerName: "Charlie", position: 3, attacks: 0 },
      { playerTag: "#PYLC", playerName: "Done", position: 4, attacks: 2 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", discordUserId: "111" },
      { playerTag: "#PYLR", discordUserId: "333" },
    ]);

    const embeds = await buildReminderDispatchEmbedsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.WAR_CWL,
        clanTag: "#PYLQ",
        clanName: "Alpha Clan",
        offsetSeconds: 3600,
        eventIdentity: "WAR:war-id:9",
        eventEndsAt: new Date("2026-04-10T01:00:00.000Z"),
        eventLabel: "war end",
      },
      nowMs: Date.parse("2026-04-10T00:30:00.000Z"),
      cocService: null,
    });

    expect(embeds).toHaveLength(1);
    const description = String(embeds[0].toJSON().description ?? "");
    const rosterLines = description
      .split("\n")
      .filter((line) => line.startsWith("#"));
    expect(rosterLines).toEqual([
      "#1 - Alpha - <@111> - 2 / 2",
      "#2 - :no: Bravo - 1 / 2",
      "#3 - Charlie - <@333> - 2 / 2",
    ]);
    expect(description).not.toContain("Done");
  });

  it("renders CWL roster from active CWL war participants only and sorts by map position", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLG", discordUserId: "222" },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        state: "inWar",
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "inWar",
        clan: {
          tag: "#PYLG",
          members: [{ tag: "#PYLV", name: "Outside", mapPosition: 1, attacks: [] }],
        },
        opponent: {
          tag: "#PYLQ",
          members: [
            { tag: "#PYLQ", name: "One", mapPosition: 1, attacks: [] },
            { tag: "#PYLG", name: "Two", mapPosition: 2, attacks: [] },
            { tag: "#PYLR", name: "Done", mapPosition: 3, attacks: [{}, {}] },
          ],
        },
      }),
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    };

    const embeds = await buildReminderDispatchEmbedsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.WAR_CWL,
        clanTag: "#PYLQ",
        clanName: "CWL Clan",
        offsetSeconds: 3600,
        eventIdentity: "CWL:#PYLQ:1712700000000",
        eventEndsAt: new Date("2026-04-10T01:00:00.000Z"),
        eventLabel: "cwl war end",
      },
      nowMs: Date.parse("2026-04-10T00:30:00.000Z"),
      cocService,
    });

    const description = String(embeds[0].toJSON().description ?? "");
    const rosterLines = description
      .split("\n")
      .filter((line) => line.startsWith("#"));
    expect(rosterLines).toEqual([
      "#1 - :no: One - 1 / 1",
      "#2 - Two - <@222> - 1 / 1",
    ]);
    expect(description).not.toContain("Outside");
    expect(description).not.toContain("Done");
  });

  it("renders RAIDS roster sorted by remaining attacks then player name and excludes non-season members", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLG", discordUserId: "222" },
      { playerTag: "#PYLR", discordUserId: "333" },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn(),
      getClanWarLeagueWar: vi.fn(),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260410T070000.000Z",
          endTime: "20260413T070000.000Z",
          members: [
            { tag: "#PYLQ", name: "Zulu", attacks: 5 },
            { tag: "#PYLG", name: "Bravo", attacks: 0 },
            { tag: "#PYLR", name: "Alpha", attacks: 5 },
            { tag: "#PYLC", name: "Spent", attacks: 6 },
          ],
        },
      ]),
      getClan: vi.fn().mockResolvedValue({
        members: [
          { tag: "#PYLQ", name: "Zulu" },
          { tag: "#PYLG", name: "Bravo" },
          { tag: "#PYLR", name: "Alpha" },
          { tag: "#PYLV", name: "IneligibleElsewhere" },
        ],
      }),
    };

    const embeds = await buildReminderDispatchEmbedsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.RAIDS,
        clanTag: "#PYLQ",
        clanName: "Raid Clan",
        offsetSeconds: 1800,
        eventIdentity: "RAIDS:FWA|#PYLQ:1712700000000",
        eventEndsAt: new Date("2026-04-13T07:00:00.000Z"),
        eventLabel: "raid weekend",
      },
      nowMs: Date.parse("2026-04-11T00:00:00.000Z"),
      cocService,
    });

    const description = String(embeds[0].toJSON().description ?? "");
    const rosterLines = description
      .split("\n")
      .filter((line) => line.includes("/ 6"));
    expect(rosterLines).toEqual([
      "Alpha - <@333> - 1 / 6",
      ":no: Zulu - 1 / 6",
      "Bravo - <@222> - 6 / 6",
    ]);
    expect(description).not.toContain("Spent");
    expect(description).not.toContain("IneligibleElsewhere");
    expect(description).not.toContain("#1 -");
  });

  it("splits long roster output into at most two embeds with continuation-only second embed", async () => {
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 80 }, (_, index) => ({
        playerTag: "#PYLQ",
        playerName: `Player_${String(index + 1).padStart(2, "0")}_${"X".repeat(120)}`,
        position: index + 1,
        attacks: 0,
      })),
    );

    const embeds = await buildReminderDispatchEmbedsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.WAR_CWL,
        clanTag: "#PYLQ",
        clanName: "Overflow Clan",
        offsetSeconds: 3600,
        eventIdentity: "WAR:war-id:55",
        eventEndsAt: new Date("2026-04-10T01:00:00.000Z"),
        eventLabel: "war end",
      },
      nowMs: Date.parse("2026-04-10T00:30:00.000Z"),
      cocService: null,
    });

    expect(embeds).toHaveLength(2);
    const first = embeds[0].toJSON();
    const second = embeds[1].toJSON();
    expect(first.color).toBe(second.color);
    expect(second.title).toBeUndefined();
    expect(String(second.description ?? "")).not.toContain("Clan: **");
    expect(String(second.description ?? "")).not.toContain("Players With Attacks Remaining");

    const combinedRosterLines = [
      ...String(first.description ?? "").split("\n"),
      ...String(second.description ?? "").split("\n"),
    ].filter((line) => line.startsWith("#"));
    expect(combinedRosterLines.length).toBeGreaterThan(0);
    expect(combinedRosterLines.length).toBeLessThan(80);
    expect(
      combinedRosterLines.every((line) =>
        /^#\d+ - :no: Player_\d{2}_X+ - 2 \/ 2$/.test(line),
      ),
    ).toBe(true);
  });
});
