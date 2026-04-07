import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderType } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  warAttacks: {
    findMany: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  ReminderDispatchService,
  buildReminderDispatchContentsForTest,
} from "../src/services/reminders/ReminderDispatchService";

function buildValidPlayerTag(index: number): string {
  const alphabet = "PYLQGRJCUV0289";
  let value = Math.max(0, Math.trunc(index));
  let tag = "";
  do {
    tag = `${alphabet[value % alphabet.length]}${tag}`;
    value = Math.floor(value / alphabet.length);
  } while (value > 0);
  return `#${tag.padStart(4, "P")}`;
}

describe("ReminderDispatchService roster rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findFirst.mockResolvedValue({ state: "inWar", warId: 9 });
  });

  it("renders WAR reminder content in plain text with inline mentions and updated header lines", async () => {
    prismaMock.warAttacks.findMany.mockResolvedValue([
      { playerTag: "#PYLG", playerName: "Bravo", playerPosition: 2, attacksUsed: 1 },
      { playerTag: "#PYLQ", playerName: "Alpha", playerPosition: 1, attacksUsed: 0 },
      { playerTag: "#PYLR", playerName: "Charlie", playerPosition: 3, attacksUsed: 0 },
      { playerTag: "#PYLC", playerName: "Done", playerPosition: 4, attacksUsed: 2 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", discordUserId: "111" },
      { playerTag: "#PYLR", discordUserId: "333" },
    ]);

    const contents = await buildReminderDispatchContentsForTest({
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

    expect(contents).toHaveLength(1);
    const lines = contents[0].split("\n");
    expect(lines[0]).toBe("### War ends in 1h");
    expect(lines[1]).toBe("Clan: Alpha Clan #PYLQ");
    expect(lines[2]).toBe("Time remaining: <t:1775782800:R> (1800s)");
    expect(lines[3]).toBe("Ends at: <t:1775782800:F> (<t:1775782800:R>)");
    expect(contents[0]).not.toContain("WAR reminder");
    expect(contents[0]).not.toContain("CWL reminder");
    expect(contents[0]).not.toContain("Configured offset");
    expect(contents[0]).not.toContain("Event timing");

    const rosterLines = lines.filter((line) => /^#\d+ /.test(line));
    expect(rosterLines).toEqual([
      "#1 - Alpha - <@111> - 2 / 2",
      "#2 - :no: Bravo - 1 / 2",
      "#3 - Charlie - <@333> - 2 / 2",
    ]);
    expect(contents[0]).not.toContain("Done");
  });

  it("ignores stale FwaWarMemberCurrent data when WarAttacks already has the authoritative counts", async () => {
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", playerName: "Stale Alpha", position: 1, attacks: 0 },
      { playerTag: "#PYLG", playerName: "Stale Bravo", position: 2, attacks: 0 },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", playerName: "Fresh Alpha", playerPosition: 1, attacksUsed: 2 },
      { playerTag: "#PYLG", playerName: "Fresh Bravo", playerPosition: 2, attacksUsed: 1 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLG", discordUserId: "222" },
    ]);

    const contents = await buildReminderDispatchContentsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.WAR_CWL,
        clanTag: "#PYLQ",
        clanName: "Authoritative Clan",
        offsetSeconds: 3600,
        eventIdentity: "WAR:war-id:9",
        eventEndsAt: new Date("2026-04-10T01:00:00.000Z"),
        eventLabel: "war end",
      },
      nowMs: Date.parse("2026-04-10T00:30:00.000Z"),
      cocService: null,
    });

    expect(prismaMock.fwaWarMemberCurrent.findMany).not.toHaveBeenCalled();
    const rosterLines = contents[0].split("\n").filter((line) => /^#\d+ /.test(line));
    expect(rosterLines).toEqual(["#2 - Fresh Bravo - <@222> - 1 / 2"]);
    expect(contents[0]).not.toContain("Fresh Alpha");
    expect(contents[0]).not.toContain("Stale Alpha");
    expect(contents[0]).not.toContain("Stale Bravo");
  });

  it("keeps multiple accounts for the same linked user adjacent", async () => {
    prismaMock.warAttacks.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", playerName: "First", playerPosition: 1, attacksUsed: 0 },
      { playerTag: "#PYLG", playerName: "Middle", playerPosition: 2, attacksUsed: 0 },
      { playerTag: "#PYLR", playerName: "Second", playerPosition: 3, attacksUsed: 0 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", discordUserId: "111" },
      { playerTag: "#PYLR", discordUserId: "111" },
    ]);

    const contents = await buildReminderDispatchContentsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.WAR_CWL,
        clanTag: "#PYLQ",
        clanName: "Adjacency Clan",
        offsetSeconds: 3600,
        eventIdentity: "WAR:war-id:9",
        eventEndsAt: new Date("2026-04-10T01:00:00.000Z"),
        eventLabel: "war end",
      },
      nowMs: Date.parse("2026-04-10T00:30:00.000Z"),
      cocService: null,
    });

    expect(contents[0].split("\n").filter((line) => /^#\d+ /.test(line))).toEqual([
      "#1 - First - <@111> - 2 / 2",
      "#3 - Second - <@111> - 2 / 2",
      "#2 - :no: Middle - 2 / 2",
    ]);
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
            { tag: "#PYLR", name: "Done", mapPosition: 3, attacks: [{}] },
          ],
        },
      }),
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    };

    const contents = await buildReminderDispatchContentsForTest({
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

    const rosterLines = contents[0]
      .split("\n")
      .filter((line) => /^#\d+ /.test(line));
    expect(rosterLines).toEqual([
      "#1 - :no: One - 1 / 1",
      "#2 - Two - <@222> - 1 / 1",
    ]);
    expect(contents[0]).not.toContain("Outside");
    expect(contents[0]).not.toContain("Done");
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

    const contents = await buildReminderDispatchContentsForTest({
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

    const rosterLines = contents[0]
      .split("\n")
      .filter((line) => line.includes("/ 6"));
    expect(rosterLines).toEqual([
      "Alpha - <@333> - 1 / 6",
      ":no: Zulu - 1 / 6",
      "Bravo - <@222> - 6 / 6",
    ]);
    expect(contents[0]).not.toContain("Spent");
    expect(contents[0]).not.toContain("IneligibleElsewhere");
    expect(contents[0]).not.toContain("#1 -");
  });

  it("splits long reminder output into two plain-text messages on whole lines only", async () => {
    prismaMock.warAttacks.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        playerTag: buildValidPlayerTag(index),
        playerName: `Player_${String(index + 1).padStart(2, "0")}_${"X".repeat(90)}`,
        playerPosition: index + 1,
        attacksUsed: 0,
      })),
    );

    const contents = await buildReminderDispatchContentsForTest({
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

    expect(contents).toHaveLength(2);
    expect(contents.every((content) => content.length <= 2000)).toBe(true);
    expect(contents[1]).not.toContain("Clan: Overflow Clan #PYLQ");

    const combinedRosterLines = contents
      .flatMap((content) => content.split("\n"))
      .filter((line) => /^#\d+ /.test(line));
    expect(combinedRosterLines).toHaveLength(30);
    expect(
      combinedRosterLines.every((line) =>
        /^#\d+ - :no: Player_\d{2}_X+ - 2 \/ 2$/.test(line),
      ),
    ).toBe(true);
  });

  it("splits overflow into at most three messages and stops after the third message", async () => {
    prismaMock.warAttacks.findMany.mockResolvedValue(
      Array.from({ length: 240 }, (_, index) => ({
        playerTag: buildValidPlayerTag(index + 1000),
        playerName: `Player_${String(index + 1).padStart(3, "0")}_${"Y".repeat(80)}`,
        playerPosition: index + 1,
        attacksUsed: 0,
      })),
    );

    const contents = await buildReminderDispatchContentsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.WAR_CWL,
        clanTag: "#PYLQ",
        clanName: "Cap Clan",
        offsetSeconds: 3600,
        eventIdentity: "WAR:war-id:55",
        eventEndsAt: new Date("2026-04-10T01:00:00.000Z"),
        eventLabel: "war end",
      },
      nowMs: Date.parse("2026-04-10T00:30:00.000Z"),
      cocService: null,
    });

    expect(contents).toHaveLength(3);
    expect(contents.every((content) => content.length <= 2000)).toBe(true);
    const renderedRosterLines = contents
      .flatMap((content) => content.split("\n"))
      .filter((line) => /^#\d+ /.test(line));
    expect(renderedRosterLines.length).toBeGreaterThan(0);
    expect(renderedRosterLines.length).toBeLessThan(240);
  });

  it("skips WAR roster reminder rendering during preparation state", async () => {
    prismaMock.currentWar.findFirst.mockResolvedValue({ state: "preparation", warId: 9 });
    prismaMock.warAttacks.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", playerName: "Alpha", playerPosition: 1, attacksUsed: 0 },
    ]);

    const contents = await buildReminderDispatchContentsForTest({
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
      nowMs: Date.parse("2026-04-09T00:30:00.000Z"),
      cocService: null,
    });

    expect(contents).toEqual([]);
  });

  it("skips CWL roster reminder rendering when CWL has no active battle-day war", async () => {
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        state: "inWar",
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        clan: {
          tag: "#PYLQ",
          members: [{ tag: "#PYLQ", name: "One", mapPosition: 1, attacks: [] }],
        },
        opponent: {
          tag: "#PYLG",
          members: [],
        },
      }),
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    };

    const contents = await buildReminderDispatchContentsForTest({
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

    expect(contents).toEqual([]);
  });

  it("skips RAIDS roster reminder rendering before raid weekend is active", async () => {
    const cocService = {
      getClanWarLeagueGroup: vi.fn(),
      getClanWarLeagueWar: vi.fn(),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260412T070000.000Z",
          endTime: "20260415T070000.000Z",
          members: [{ tag: "#PYLQ", name: "Zulu", attacks: 0 }],
        },
      ]),
      getClan: vi.fn().mockResolvedValue({
        members: [{ tag: "#PYLQ", name: "Zulu" }],
      }),
    };

    const contents = await buildReminderDispatchContentsForTest({
      input: {
        guildId: "guild-1",
        channelId: "channel-1",
        reminderId: "rem-1",
        type: ReminderType.RAIDS,
        clanTag: "#PYLQ",
        clanName: "Raid Clan",
        offsetSeconds: 1800,
        eventIdentity: "RAIDS:FWA|#PYLQ:1712700000000",
        eventEndsAt: new Date("2026-04-15T07:00:00.000Z"),
        eventLabel: "raid weekend",
      },
      nowMs: Date.parse("2026-04-11T00:00:00.000Z"),
      cocService,
    });

    expect(contents).toEqual([]);
  });

  it("dispatches plain-text payloads with inline mentions and no embed fallback", async () => {
    prismaMock.warAttacks.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", playerName: "Alpha", playerPosition: 1, attacksUsed: 0 },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", discordUserId: "111" },
    ]);

    const send = vi.fn().mockResolvedValue({ id: "message-1" });
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send,
        }),
      },
    } as any;
    const service = new ReminderDispatchService({
      nowMsProvider: () => Date.parse("2026-04-10T00:30:00.000Z"),
      cocService: null,
    });

    const result = await service.dispatchReminder(client, {
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
    });

    expect(result).toEqual({
      status: "sent",
      messageId: "message-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("#1 - Alpha - <@111> - 2 / 2"),
      allowedMentions: {
        parse: ["users"],
      },
    });
    expect(send.mock.calls[0][0]).not.toHaveProperty("embeds");
  });

  it("does not send a message when attack window is inactive in dispatch flow", async () => {
    prismaMock.currentWar.findFirst.mockResolvedValue({ state: "preparation", warId: 9 });
    prismaMock.warAttacks.findMany.mockResolvedValue([
      { playerTag: "#PYLQ", playerName: "Alpha", playerPosition: 1, attacksUsed: 0 },
    ]);

    const send = vi.fn();
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send,
        }),
      },
    } as any;
    const service = new ReminderDispatchService({
      nowMsProvider: () => Date.parse("2026-04-09T00:30:00.000Z"),
      cocService: null,
    });

    const result = await service.dispatchReminder(client, {
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
    });

    expect(result).toEqual({
      status: "failed",
      errorMessage: "attack_window_not_active",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
