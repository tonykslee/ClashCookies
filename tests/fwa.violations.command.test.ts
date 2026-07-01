import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  autocompleteFwaViolationsCommand,
  buildFwaViolationsClanAutocompleteChoices,
  runFwaViolationsCommand,
} from "../src/commands/fwa/violationsCommand";

function d(value: string): Date {
  return new Date(value);
}

function makePlayerHistoryEntry(index: number) {
  return {
    violationId: `viol-${index}`,
    evaluationId: `eval-${index}`,
    warId: 100 + index,
    warStartTime: d(`2026-02-0${index + 1}T00:00:00.000Z`),
    warEndTime: d(`2026-02-0${index + 1}T01:00:00.000Z`),
    clanTag: "#2QG2C08UP",
    clanName: "Alpha",
    opponentTag: "#OPP",
    opponentName: "Opponent",
    expectedOutcome: "WIN",
    loseStyle: "TRIPLE",
    playerNameSnapshot: `Player ${index + 1}`,
    townHallLevelSnapshot: 15,
    playerPosition: index + 1,
    violationType: "OTHER_PLAN_VIOLATION",
    reasonLabel: null,
    expectedBehavior: "Expected",
    actualBehavior: "Actual",
    breachStarsAt: null,
    breachTimeRemaining: null,
    attackEvidence: {
      attacks: [],
      breachContext: null,
    },
  };
}

function makeAllianceOverviewResult() {
  return {
    outcome: "success",
    period: "30d" as const,
    cutoff: d("2026-02-01T00:00:00.000Z"),
    trackingSince: d("2026-01-01T00:00:00.000Z"),
    evaluatedWarCount: 5,
    affectedWarCount: 2,
    violationCount: 3,
    distinctPlayerCount: 2,
    distinctClanCount: 1,
    distinctCurrentDiscordUserCount: 1,
    clanSummaries: [],
    topPlayers: [],
    hasCompletedEvaluations: true,
  };
}

function makeClanLeaderboardResult() {
  return {
    outcome: "success",
    clanTag: "#2QG2C08UP",
    clanName: "Alpha",
    period: "30d" as const,
    cutoff: d("2026-02-01T00:00:00.000Z"),
    trackingSince: d("2026-01-01T00:00:00.000Z"),
    evaluatedWarCount: 5,
    affectedWarCount: 2,
    violationCount: 3,
    distinctPlayerCount: 2,
    players: [],
    hasCompletedEvaluations: true,
  };
}

function makeDiscordUserAggregateResult() {
  return {
    outcome: "success",
    discordUserId: "111111111111111111",
    period: "30d" as const,
    cutoff: d("2026-02-01T00:00:00.000Z"),
    clanTag: null,
    trackingSince: d("2026-01-01T00:00:00.000Z"),
    currentLinkedAccountCount: 2,
    violatingAccountCount: 1,
    violationCount: 2,
    affectedWarCount: 1,
    hasViolationsInPeriod: true,
    accounts: [],
  };
}

function makePlayerHistoryResult(entryCount: number) {
  return {
    outcome: "success",
    period: "30d" as const,
    cutoff: d("2026-02-01T00:00:00.000Z"),
    trackingSince: d("2026-01-01T00:00:00.000Z"),
    playerTag: "#PYLQ0289",
    playerName: "Current Player",
    townHallLevel: 15,
    discordUserId: "111111111111111111",
    violationCount: entryCount,
    affectedWarCount: entryCount > 0 ? 1 : 0,
    hasRecordedViolations: true,
    hasViolationsInPeriod: entryCount > 0,
    entries: Array.from({ length: entryCount }, (_value, index) =>
      makePlayerHistoryEntry(index),
    ),
  };
}

function makeCollectorHarness() {
  const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
  const collector = {
    on: vi.fn((event: "collect" | "end", handler: (...args: any[]) => Promise<void> | void) => {
      handlers[event] = handler;
      return collector;
    }),
  };
  const replyMessage = {
    createMessageComponentCollector: vi.fn(() => collector),
  };
  return { handlers, collector, replyMessage };
}

function makeButtonInteraction(customId: string, userId: string) {
  return {
    customId,
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInteraction(input: {
  guildId?: string | null;
  visibility?: "private" | "public" | null;
  period?: "30d" | "lifetime" | null;
  clan?: string | null;
  player?: string | null;
  discordUser?: { id: string } | null;
  focusedName?: "player" | "clan" | "tag" | "war-id";
  focusedValue?: string;
}) {
  const collector = makeCollectorHarness();
  const payloads: Array<Record<string, unknown>> = [];
  const interaction: any = {
    id: "interaction-violations",
    guildId: input.guildId ?? "guild-1",
    channelId: "channel-1",
    client: {},
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    respond: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockImplementation(async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      interaction.replied = true;
      return collector.replyMessage;
    }),
    options: {
      getString: vi.fn((name: string) => {
        if (name === "period") return input.period ?? null;
        if (name === "visibility") return input.visibility ?? null;
        if (name === "clan") return input.clan ?? null;
        if (name === "player") return input.player ?? null;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name === "discord-user") return input.discordUser ?? null;
        return null;
      }),
      getFocused: vi.fn(() => ({
        name: input.focusedName ?? "player",
        value: input.focusedValue ?? "",
      })),
    },
  };

  return { interaction, collector, payloads };
}

describe("/fwa violations command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches alliance overview, clan, player, and discord-user routes with the selected period", async () => {
    const historyService = {
      getAllianceOverview: vi.fn().mockResolvedValue(makeAllianceOverviewResult()),
      getClanLeaderboard: vi.fn().mockResolvedValue(makeClanLeaderboardResult()),
      getPlayerHistory: vi.fn().mockResolvedValue(makePlayerHistoryResult(1)),
      getDiscordUserAggregate: vi.fn().mockResolvedValue(makeDiscordUserAggregateResult()),
    };
    const resolveTownHallEmojiMap = vi.fn().mockResolvedValue(new Map([[15, "TH15"]]));

    const overview = makeInteraction({ guildId: "guild-1" });
    await runFwaViolationsCommand(overview.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
    });
    expect(overview.interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(historyService.getAllianceOverview).toHaveBeenCalledWith({
      guildId: "guild-1",
      period: "30d",
    });
    expect(historyService.getClanLeaderboard).not.toHaveBeenCalled();
    expect(historyService.getPlayerHistory).not.toHaveBeenCalled();
    expect(historyService.getDiscordUserAggregate).not.toHaveBeenCalled();

    const clan = makeInteraction({
      guildId: "guild-1",
      period: "lifetime",
      clan: "#2qg2c08up",
      visibility: "public",
    });
    await runFwaViolationsCommand(clan.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
    });
    expect(clan.interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(historyService.getClanLeaderboard).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
    });

    const player = makeInteraction({
      guildId: "guild-1",
      player: "pylq0289",
    });
    await runFwaViolationsCommand(player.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
    });
    expect(historyService.getPlayerHistory).toHaveBeenCalledWith({
      guildId: "guild-1",
      playerTag: "#PYLQ0289",
      period: "30d",
    });

    const discordUser = makeInteraction({
      guildId: "guild-1",
      clan: "#2qg2c08up",
      discordUser: { id: "111111111111111111" },
      period: "lifetime",
    });
    await runFwaViolationsCommand(discordUser.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
    });
    expect(historyService.getDiscordUserAggregate).toHaveBeenCalledWith({
      guildId: "guild-1",
      discordUserId: "111111111111111111",
      period: "lifetime",
      clanTag: "#2QG2C08UP",
    });

    expect(resolveTownHallEmojiMap).toHaveBeenCalledTimes(4);
    expect(overview.payloads[0]?.allowedMentions).toEqual({ parse: [] });
    expect(clan.payloads[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it("rejects player+clan and player+discord-user before any service read", async () => {
    const historyService = {
      getAllianceOverview: vi.fn(),
      getClanLeaderboard: vi.fn(),
      getPlayerHistory: vi.fn(),
      getDiscordUserAggregate: vi.fn(),
    };

    const playerAndClan = makeInteraction({
      guildId: "guild-1",
      player: "#PYLQ0289",
      clan: "#2QG2C08UP",
    });
    await runFwaViolationsCommand(playerAndClan.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap: vi.fn(),
    });
    expect(playerAndClan.interaction.deferReply).not.toHaveBeenCalled();
    expect(playerAndClan.interaction.reply).toHaveBeenCalledTimes(1);
    expect(playerAndClan.interaction.reply.mock.calls[0]?.[0]?.allowedMentions).toEqual({
      parse: [],
    });
    expect(String(playerAndClan.interaction.reply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Player history cannot currently be filtered by clan.",
    );

    const playerAndDiscord = makeInteraction({
      guildId: "guild-1",
      player: "#PYLQ0289",
      discordUser: { id: "111111111111111111" },
    });
    await runFwaViolationsCommand(playerAndDiscord.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap: vi.fn(),
    });
    expect(playerAndDiscord.interaction.deferReply).not.toHaveBeenCalled();
    expect(playerAndDiscord.interaction.reply).toHaveBeenCalledTimes(1);
    expect(historyService.getAllianceOverview).not.toHaveBeenCalled();
    expect(historyService.getClanLeaderboard).not.toHaveBeenCalled();
    expect(historyService.getPlayerHistory).not.toHaveBeenCalled();
    expect(historyService.getDiscordUserAggregate).not.toHaveBeenCalled();
  });

  it("rejects invalid clan and invalid player input before any service read", async () => {
    const historyService = {
      getAllianceOverview: vi.fn(),
      getClanLeaderboard: vi.fn(),
      getPlayerHistory: vi.fn(),
      getDiscordUserAggregate: vi.fn(),
    };

    const invalidClan = makeInteraction({
      guildId: "guild-1",
      clan: "not-a-tag",
    });
    await runFwaViolationsCommand(invalidClan.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap: vi.fn(),
    });
    expect(invalidClan.interaction.reply).toHaveBeenCalledTimes(1);
    expect(String(invalidClan.interaction.reply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Please provide a valid `clan` tag.",
    );
    expect(invalidClan.interaction.reply.mock.calls[0]?.[0]?.allowedMentions).toEqual({
      parse: [],
    });

    const invalidPlayer = makeInteraction({
      guildId: "guild-1",
      player: "bad-tag",
    });
    await runFwaViolationsCommand(invalidPlayer.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap: vi.fn(),
    });
    expect(invalidPlayer.interaction.reply).toHaveBeenCalledTimes(1);
    expect(String(invalidPlayer.interaction.reply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Please provide a valid `player` tag.",
    );
    expect(invalidPlayer.interaction.reply.mock.calls[0]?.[0]?.allowedMentions).toEqual({
      parse: [],
    });
    expect(historyService.getAllianceOverview).not.toHaveBeenCalled();
  });

  it("responds privately on autocomplete failure once with an empty array", async () => {
    const historyService = {
      getPlayerAutocompleteChoices: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const interaction = makeInteraction({
      guildId: "guild-1",
      focusedName: "player",
      focusedValue: "pylq",
    });

    await autocompleteFwaViolationsCommand(interaction.interaction, {
      historyService: historyService as any,
    });

    expect(interaction.interaction.respond).toHaveBeenCalledTimes(1);
    expect(interaction.interaction.respond).toHaveBeenCalledWith([]);
  });

  it("delegates player autocomplete and returns no more than 25 choices", async () => {
    const historyService = {
      getPlayerAutocompleteChoices: vi.fn().mockImplementation(
        async (input: { limit?: number }) =>
          Array.from({ length: Math.min(Number(input.limit ?? 25), 25) }, (_value, index) => ({
            name: `Player ${index + 1} (#P${index})`,
            value: `#P${index}`,
          })),
      ),
    };
    const interaction = makeInteraction({
      guildId: "guild-1",
      focusedName: "player",
      focusedValue: "pylq",
    });

    await autocompleteFwaViolationsCommand(interaction.interaction, {
      historyService: historyService as any,
    });

    expect(historyService.getPlayerAutocompleteChoices).toHaveBeenCalledWith({
      guildId: "guild-1",
      focusedText: "pylq",
      limit: 25,
    });
    expect(interaction.interaction.respond).toHaveBeenCalledTimes(1);
    expect(interaction.interaction.respond.mock.calls[0]?.[0]).toHaveLength(25);
  });

  it("returns canonical clan tags from autocomplete queries", async () => {
    const loader = vi.fn().mockResolvedValue(
      Array.from({ length: 30 }, (_value, index) => ({
        name: `Clan ${index + 1} (#2QG2C08UP)`,
        value: "#2QG2C08UP",
      })),
    );

    const choices = await buildFwaViolationsClanAutocompleteChoices({
      focusedText: "#2qg",
      limit: 25,
      loadChoices: loader,
    });

    expect(loader).toHaveBeenCalledWith("#2qg");
    expect(choices).toHaveLength(25);
    expect(choices[0]).toEqual({
      name: "Clan 1 (#2QG2C08UP)",
      value: "#2QG2C08UP",
    });
  });

  it("starts a paginator only when player history has more than one entry", async () => {
    const historyService = {
      getAllianceOverview: vi.fn(),
      getClanLeaderboard: vi.fn(),
      getPlayerHistory: vi.fn().mockResolvedValue(makePlayerHistoryResult(2)),
      getDiscordUserAggregate: vi.fn(),
    };
    const resolveTownHallEmojiMap = vi.fn().mockResolvedValue(new Map([[15, "TH15"]]));
    const { interaction, collector, payloads } = makeInteraction({
      guildId: "guild-1",
      player: "#PYLQ0289",
    });

    await runFwaViolationsCommand(interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
      paginatorTimeoutMs: 600000,
    });

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(collector.replyMessage.createMessageComponentCollector).toHaveBeenCalledTimes(1);
    const initialComponents = payloads[0]?.components as any[];
    expect(initialComponents).toHaveLength(1);
    const initialButtons = initialComponents[0]?.toJSON?.().components ?? initialComponents[0]?.components ?? [];
    expect(initialButtons[0]?.disabled).toBe(true);
    expect(initialButtons[1]?.disabled).toBe(false);

    const otherUserButton = makeButtonInteraction(
      "fwa:violations:interaction-violations:next",
      "other-user",
    );
    await collector.handlers.collect?.(otherUserButton);
    expect(otherUserButton.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        allowedMentions: { parse: [] },
      }),
    );
    expect(otherUserButton.update).not.toHaveBeenCalled();

    const nextButton = makeButtonInteraction(
      "fwa:violations:interaction-violations:next",
      "user-1",
    );
    await collector.handlers.collect?.(nextButton);
    expect(nextButton.update).toHaveBeenCalledTimes(1);
    const nextPayload = nextButton.update.mock.calls[0]?.[0] as any;
    expect(String(nextPayload.embeds?.[0]?.toJSON?.().footer?.text ?? "")).toContain("Page 2/2");
    const nextButtons = nextPayload.components?.[0]?.toJSON?.().components ?? nextPayload.components?.[0]?.components ?? [];
    expect(nextButtons[0]?.disabled).toBe(false);
    expect(nextButtons[1]?.disabled).toBe(true);

    const previousButton = makeButtonInteraction(
      "fwa:violations:interaction-violations:previous",
      "user-1",
    );
    await collector.handlers.collect?.(previousButton);
    expect(previousButton.update).toHaveBeenCalledTimes(1);
    const previousPayload = previousButton.update.mock.calls[0]?.[0] as any;
    expect(String(previousPayload.embeds?.[0]?.toJSON?.().footer?.text ?? "")).toContain("Page 1/2");
    const previousButtons = previousPayload.components?.[0]?.toJSON?.().components ?? previousPayload.components?.[0]?.components ?? [];
    expect(previousButtons[0]?.disabled).toBe(true);
    expect(previousButtons[1]?.disabled).toBe(false);

    await collector.handlers.end?.();
    const finalPayload = payloads.at(-1) as any;
    const finalButtons = finalPayload.components?.[0]?.toJSON?.().components ?? finalPayload.components?.[0]?.components ?? [];
    expect(finalButtons[0]?.disabled).toBe(true);
    expect(finalButtons[1]?.disabled).toBe(true);
    expect(resolveTownHallEmojiMap).toHaveBeenCalledTimes(1);
  });

  it("does not create a paginator for zero-entry or one-entry player history", async () => {
    const historyService = {
      getAllianceOverview: vi.fn(),
      getClanLeaderboard: vi.fn(),
      getPlayerHistory: vi.fn().mockResolvedValueOnce(makePlayerHistoryResult(0)).mockResolvedValueOnce(makePlayerHistoryResult(1)),
      getDiscordUserAggregate: vi.fn(),
    };
    const resolveTownHallEmojiMap = vi.fn().mockResolvedValue(new Map([[15, "TH15"]]));

    const zeroEntry = makeInteraction({
      guildId: "guild-1",
      player: "#PYLQ0289",
    });
    await runFwaViolationsCommand(zeroEntry.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
    });
    expect(zeroEntry.collector.replyMessage.createMessageComponentCollector).not.toHaveBeenCalled();

    const oneEntry = makeInteraction({
      guildId: "guild-1",
      player: "#PYLQ0289",
    });
    await runFwaViolationsCommand(oneEntry.interaction, {} as any, {
      historyService: historyService as any,
      resolveTownHallEmojiMap,
    });
    expect(oneEntry.collector.replyMessage.createMessageComponentCollector).not.toHaveBeenCalled();
  });
});
