import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  roster: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  rosterGroup: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  rosterSignup: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForDiscordUser: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerLinkService")>(
    "../src/services/PlayerLinkService",
  );
  return {
    ...actual,
    listPlayerLinksForDiscordUser: playerLinkServiceMock.listPlayerLinksForDiscordUser,
  };
});

import {
  ROSTER_DEFAULT_GROUPS,
  rosterService,
} from "../src/services/RosterService";

describe("RosterService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) =>
      callback(prismaMock as any),
    );
    prismaMock.roster.create.mockResolvedValue({ id: "roster-1" });
    prismaMock.roster.findUnique.mockResolvedValue({
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
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    prismaMock.rosterGroup.createMany.mockResolvedValue({ count: 2 });
    prismaMock.rosterGroup.findMany.mockResolvedValue([
      {
        id: "group-confirmed",
        key: "confirmed",
        name: "Confirmed",
        description: "Primary roster members",
        sortOrder: 0,
      },
      {
        id: "group-substitute",
        key: "substitute",
        name: "Substitute",
        description: "Reserve roster members",
        sortOrder: 1,
      },
    ]);
    prismaMock.rosterGroup.findFirst.mockResolvedValue({
      id: "group-confirmed",
      key: "confirmed",
      name: "Confirmed",
      description: "Primary roster members",
      sortOrder: 0,
    });
    prismaMock.rosterSignup.findMany.mockResolvedValue([]);
    prismaMock.rosterSignup.createMany.mockResolvedValue({ count: 0 });
    prismaMock.rosterSignup.deleteMany.mockResolvedValue({ count: 0 });
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([]);
  });

  it("creates a roster with default Confirmed and Substitute groups", async () => {
    await rosterService.createRoster({
      guildId: "guild-1",
      rosterType: "cwl",
      title: "CWL Alpha Signup",
      timezone: "PST",
      createdByDiscordUserId: "111111111111111111",
    });

    expect(prismaMock.roster.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          guildId: "guild-1",
          rosterType: "CWL",
          title: "CWL Alpha Signup",
          timezone: "America/Los_Angeles",
          displayTimezone: "America/Los_Angeles",
        }),
      }),
    );
    expect(prismaMock.rosterGroup.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining(
        ROSTER_DEFAULT_GROUPS.map((group) =>
          expect.objectContaining({
            key: group.key,
            name: group.name,
          }),
        ),
      ),
    });
  });

  it("signs up only the selected linked accounts and skips duplicates by player tag", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.rosterSignup.findMany.mockResolvedValue([{ playerTag: "#PQL0289" }]);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
      playerTags: ["#PQL0289", "#QGRJ2222"],
    });

    expect(result).toMatchObject({
      outcome: "created",
      rosterId: "roster-1",
      groupKey: "confirmed",
      groupName: "Confirmed",
      linkedTags: ["#PQL0289", "#QGRJ2222"],
      createdTags: ["#QGRJ2222"],
      duplicateTags: ["#PQL0289"],
      missingLinkedTags: [],
    });
    expect(prismaMock.rosterSignup.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "111111111111111111",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("renders grouped signup entries and includes the remove button on the roster post", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
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
        group: {
          id: "group-substitute",
          key: "substitute",
          name: "Substitute",
          description: "Reserve roster members",
          sortOrder: 1,
        },
      },
    ] as any);

    const payload = await rosterService.buildRosterSignupPayload("roster-1");

    expect(payload).toBeTruthy();
    const description = payload?.embed.toJSON().description ?? "";
    expect(description).toContain("Confirmed (1)");
    expect(description).toContain("Alpha `#PQL0289` <@111111111111111111>");
    expect(description).toContain("Substitute (1)");
    expect(description).toContain("Bravo `#QGRJ2222` <@222222222222222222>");
    const componentIds = payload?.components.flatMap((row) => {
      const rowJson = row.toJSON() as any;
      return Array.isArray(rowJson.components)
        ? rowJson.components.map((component: any) => component.custom_id ?? component.customId ?? component.data?.custom_id ?? component.data?.customId)
        : [];
    }) ?? [];
    expect(componentIds).toContain("roster-remove:roster-1");
  });

  it("builds a signup selection panel that lets a user choose linked accounts", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.rosterSignup.findMany.mockResolvedValue([{ playerTag: "#PQL0289" }]);

    const result = await rosterService.createRosterSignupSelectionPanel({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({ outcome: "ready" });
    if (result.outcome !== "ready") return;
    const payload = result.panel;
    const description = payload.embed.toJSON().description ?? "";
    expect(description).toContain("Select linked accounts to sign up for Confirmed.");
    expect(description).toContain("Selected: 0 / 2");
    const selectIds = payload.components.flatMap((row) => {
      const rowJson = row.toJSON() as any;
      return Array.isArray(rowJson.components)
        ? rowJson.components.map((component: any) => component.custom_id ?? component.customId ?? component.data?.custom_id ?? component.data?.customId)
        : [];
    });
    expect(selectIds.some((id) => String(id).startsWith("roster-selection:menu:"))).toBe(true);
    expect(payload.selectedTags).toEqual([]);
  });

  it("signs up multiple selected accounts through the roster selection session", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.rosterSignup.findMany.mockResolvedValue([]);
    prismaMock.rosterSignup.createMany.mockResolvedValue({ count: 2 });

    const opened = await rosterService.createRosterSignupSelectionPanel({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });
    if (opened.outcome !== "ready") {
      throw new Error("Expected roster selection panel to open.");
    }

    const updated = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      selectedTags: ["#PQL0289", "#QGRJ2222"],
    });
    if (updated.outcome !== "updated") {
      throw new Error("Expected roster selection panel to update.");
    }

    const confirmed = await rosterService.confirmRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
    });

    expect(confirmed).toMatchObject({
      outcome: "signup",
      result: {
        outcome: "created",
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        linkedTags: ["#PQL0289", "#QGRJ2222"],
        createdTags: ["#PQL0289", "#QGRJ2222"],
        duplicateTags: [],
        missingLinkedTags: [],
      },
    });
    expect(prismaMock.rosterSignup.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
        }),
        expect.objectContaining({
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "111111111111111111",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("lets users remove only their own signup entries", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
      { playerTag: "#PQL0289" },
    ] as any);
    prismaMock.rosterSignup.deleteMany.mockResolvedValue({ count: 1 });

    const result = await rosterService.removeRosterSignups({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      playerTags: ["#PQL0289", "#QGRJ2222"],
    });

    expect(result).toMatchObject({
      outcome: "removed",
      rosterId: "roster-1",
      removedTags: ["#PQL0289"],
      notOwnedTags: ["#QGRJ2222"],
    });
    expect(prismaMock.rosterSignup.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rosterId: "roster-1",
          discordUserId: "111111111111111111",
        }),
      }),
    );
  });
});
