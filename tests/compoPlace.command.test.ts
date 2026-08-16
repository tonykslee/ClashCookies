import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import {
  Compo,
  buildCompoReplacementCustomIdForTest,
  buildCompoReplacementSelectCustomIdForTest,
  handleCompoReplacementButton,
  handleCompoReplacementSelectMenuInteraction,
  parseCompoReplacementCustomIdForTest,
  parseCompoReplacementSelectCustomIdForTest,
} from "../src/commands/Compo";
import * as actualStateService from "../src/services/CompoActualStateService";
import { CompoPlaceService } from "../src/services/CompoPlaceService";
import { CompoReplacementService } from "../src/services/CompoReplacementService";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";

function makeInteraction(weight: string) {
  const interaction: any = {
    commandName: "compo",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => "place"),
      getString: vi.fn((name: string) => {
        if (name === "weight") return weight;
        return null;
      }),
    },
  };
  return interaction;
}

function getComponentCustomIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  return rows.flatMap((row) => {
    const normalized =
      row && typeof (row as { toJSON?: () => unknown }).toJSON === "function"
        ? (row as { toJSON: () => unknown }).toJSON()
        : row;
    if (!normalized || typeof normalized !== "object") return [];
    const components = Array.isArray((normalized as { components?: unknown[] }).components)
      ? ((normalized as { components: unknown[] }).components as unknown[])
      : [];
    return components
      .map((component) =>
        String(
          (component as { custom_id?: unknown; customId?: unknown }).custom_id ??
            (component as { custom_id?: unknown; customId?: unknown }).customId ??
            "",
        ),
      )
      .filter((value) => value.length > 0);
  });
}

function getFirstButtonState(payload: unknown): { label: string; disabled: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  const firstRow = rows[0];
  const normalized =
    firstRow && typeof (firstRow as { toJSON?: () => unknown }).toJSON === "function"
      ? (firstRow as { toJSON: () => unknown }).toJSON()
      : firstRow;
  if (!normalized || typeof normalized !== "object") return null;
  const firstComponent = Array.isArray((normalized as { components?: unknown[] }).components)
    ? (normalized as { components: unknown[] }).components[0]
    : null;
  if (!firstComponent || typeof firstComponent !== "object") return null;
  return {
    label: String((firstComponent as { label?: unknown }).label ?? ""),
    disabled: Boolean((firstComponent as { disabled?: unknown }).disabled),
  };
}

function getEmbedJSON(payload: unknown): {
  description?: string;
  footer?: { text?: string };
  fields?: Array<{ name?: string; value?: string }>;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const embeds = Array.isArray((payload as { embeds?: unknown[] }).embeds)
    ? ((payload as { embeds: unknown[] }).embeds as unknown[])
    : [];
  const firstEmbed = embeds[0];
  if (!firstEmbed || typeof firstEmbed !== "object") return null;
  return typeof (firstEmbed as { toJSON?: () => unknown }).toJSON === "function"
    ? ((firstEmbed as { toJSON: () => unknown }).toJSON() as {
        description?: string;
        footer?: { text?: string };
        fields?: Array<{ name?: string; value?: string }>;
      })
    : (firstEmbed as {
        description?: string;
        footer?: { text?: string };
        fields?: Array<{ name?: string; value?: string }>;
      });
}

describe("/compo place command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the place service, keeps sheet access out of the command layer, and restores the place refresh button", async () => {
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "",
        embeds: [new EmbedBuilder().setTitle("Compo Placement Suggestions")],
        trackedClanTags: ["#AAA111"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      });
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const interaction = makeInteraction("145k");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(145000, "TH15", "guild-1");
    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(getComponentCustomIds(payload)).toEqual([
      "compo-refresh:place:user-1:145000",
      "compo-replacements:open:user-1:145000",
    ]);
    expect(getFirstButtonState(payload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
  });

  it("maps lower persisted weight buckets into the stable <=TH13 place bucket", async () => {
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "Mode Displayed: **PLACE**",
        embeds: [],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      });

    const interaction = makeInteraction("100000");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(100000, "<=TH13", "guild-1");
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(getComponentCustomIds(payload)).toEqual([
      "compo-refresh:place:user-1:100000",
      "compo-replacements:open:user-1:100000",
    ]);
    expect(getFirstButtonState(payload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
  });

  it("opens an ephemeral replacement drill-down with linked and unlinked rows, stacking valid reasons", async () => {
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "",
        embeds: [new EmbedBuilder().setTitle("Compo Placement Suggestions")],
        trackedClanTags: ["#RR"],
        eligibleClanTags: ["#RR"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      });
    const loadContextSpy = vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      guildId: "guild-1",
      sourceSyncedAt: null,
      latestSourceSyncedAt: null,
      trackedClanTags: ["#RR", "#RD"],
      eligibleClanTags: ["#RR", "#RD"],
      heatMapRefs: [],
      clans: [
        {
          clanTag: "#RR",
          clanName: "Rocky Road",
          shortName: "RR",
          base: {
            resolvedTotalWeight: 145000,
            unresolvedWeightCount: 0,
            missingTo50Count: 0,
            memberCount: 50,
          },
          members: [],
        },
        {
          clanTag: "#RD",
          clanName: "Rising Dawn",
          shortName: "RD",
          base: {
            resolvedTotalWeight: 144000,
            unresolvedWeightCount: 0,
            missingTo50Count: 0,
            memberCount: 50,
          },
          members: [],
        },
      ],
    } as any);
    const resolverSpy = vi
      .spyOn(CompoReplacementService.prototype, "resolveReplacementCandidates")
      .mockResolvedValue({
        inputWeight: 145000,
        bucket: "TH15",
        summaryByClan: [
          {
            clanTag: "#RR",
            clanName: "Rocky Road",
            uniqueCandidateCount: 4,
            fillerCount: 2,
            inactiveCount: 2,
            unlinkedCount: 1,
            surplusCount: 2,
          },
          {
            clanTag: "#RD",
            clanName: "Rising Dawn",
            uniqueCandidateCount: 0,
            fillerCount: 0,
            inactiveCount: 0,
            unlinkedCount: 0,
          },
        ],
        candidates: [
          {
            clanTag: "#RR",
            clanName: "Rocky Road",
            playerTag: "#A1",
            playerName: "Alice",
            resolvedWeight: 145000,
            resolvedBucket: "TH15",
            discordUserId: "123",
            discordMention: "<@123>",
            inactiveLabel: null,
            violationCount30d: 3,
            surplusDelta: 3,
            reasons: { filler: true, inactive: false, unlinked: false, surplus: true },
          },
          {
            clanTag: "#RR",
            clanName: "Rocky Road",
            playerTag: "#B2",
            playerName: "Bob",
            resolvedWeight: 145000,
            resolvedBucket: "TH15",
            discordUserId: "456",
            discordMention: "<@456>",
            inactiveLabel: "6d",
            reasons: { filler: false, inactive: true, unlinked: false },
          },
          {
            clanTag: "#RR",
            clanName: "Rocky Road",
            playerTag: "#C3",
            playerName: "Cara",
            resolvedWeight: 145000,
            resolvedBucket: "TH15",
            discordUserId: null,
            discordMention: null,
            inactiveLabel: "6d",
            reasons: { filler: true, inactive: true, unlinked: true },
          },
          {
            clanTag: "#RR",
            clanName: "Rocky Road",
            playerTag: "#D4",
            playerName: "Drew",
            resolvedWeight: 146000,
            resolvedBucket: "TH15",
            discordUserId: "789",
            discordMention: "<@789>",
            inactiveLabel: null,
            violationCount30d: 0,
            surplusDelta: 2,
            reasons: { filler: false, inactive: false, unlinked: false, surplus: true },
          },
        ],
      } as any);

    const interaction = makeInteraction("145k");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(145000, "TH15", "guild-1");
    const buttonPayload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(getComponentCustomIds(buttonPayload)).toEqual([
      "compo-refresh:place:user-1:145000",
      "compo-replacements:open:user-1:145000",
    ]);

    const replacementInteraction: any = {
      customId: "compo-replacements:open:user-1:145000",
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        replacementInteraction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleCompoReplacementButton } = await import("../src/commands/Compo");
    await handleCompoReplacementButton(replacementInteraction as any);

    expect(loadContextSpy).toHaveBeenCalledTimes(1);
    expect(resolverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        weight: 145000,
        includeViolationCounts: true,
      }),
    );
    expect(replacementInteraction.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.any(Number) }),
    );

    const detailPayload = replacementInteraction.editReply.mock.calls.at(-1)?.[0];
    expect(detailPayload?.content ?? "").toBe("");
    expect(Array.isArray(detailPayload?.embeds)).toBe(true);
    const embed = getEmbedJSON(detailPayload);
    expect(String(embed?.description ?? "")).toContain("Legend: 🧍 filler · 😴 inactive · 📵 unlinked · ⚠ 30d violations · 📈 surplus bucket");
    expect(String(embed?.description ?? "")).toContain("Filters: All clans · Priority · Violations: Any");
    expect(String(embed?.description ?? "")).toContain("Showing 3 of 4 candidates");
    expect(String(embed?.description ?? "")).toContain("**RR**");
    expect(String(embed?.description ?? "")).toContain("<@123> Alice — 145k — 🧍 filler · ⚠ 3 violations · 📈 surplus TH15 (+3)");
    expect(String(embed?.description ?? "")).toContain("<@456> Bob — 145k — 😴 inactive 6d");
    expect(String(embed?.description ?? "")).not.toContain("Drew");
    expect(String(embed?.description ?? "")).not.toContain("<@123> Alice — 145k — 📵 unlinked");
    expect(String(embed?.description ?? "")).not.toContain("<@456> Bob — 145k — 📵 unlinked");

    const typeSelectId = getComponentCustomIds(detailPayload).find((customId) =>
      customId.startsWith("compo-replacements:s:t:"),
    );
    expect(typeSelectId).toBe("compo-replacements:s:t:user-1:145000:0:-:p:0:0");
    const typeInteraction: any = {
      customId: typeSelectId,
      values: ["surplus"],
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferUpdate: vi.fn(async () => {
        typeInteraction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCompoReplacementSelectMenuInteraction(typeInteraction as any);

    expect(typeInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    const filteredPayload = typeInteraction.editReply.mock.calls.at(-1)?.[0];
    const filteredEmbed = getEmbedJSON(filteredPayload);
    expect(String(filteredEmbed?.description ?? "")).toContain("Filters: All clans · Surplus bucket · Violations: Any");
    expect(String(filteredEmbed?.description ?? "")).toContain("Showing 2 of 4 candidates");
    expect(String(filteredEmbed?.description ?? "")).toContain("Drew");
    expect(getComponentCustomIds(filteredPayload)).toContain(
      "compo-replacements:s:t:user-1:145000:0:-:p:8:0",
    );
  });

  it("shows an empty state when no replacement candidates are found", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      guildId: "guild-1",
      sourceSyncedAt: null,
      latestSourceSyncedAt: null,
      trackedClanTags: [],
      eligibleClanTags: [],
      heatMapRefs: [],
      clans: [],
    } as any);
    vi.spyOn(CompoReplacementService.prototype, "resolveReplacementCandidates").mockResolvedValue({
      inputWeight: 145000,
      bucket: "TH15",
      summaryByClan: [],
      candidates: [],
    } as any);

    const interaction: any = {
      customId: "compo-replacements:open:user-1:145000",
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleCompoReplacementButton } = await import("../src/commands/Compo");
    await handleCompoReplacementButton(interaction as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toBe("No replacement candidates found from current stored data.");
    expect(payload?.embeds ?? []).toEqual([]);
  });

  it("keeps explorer controls when filters remove every candidate", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      guildId: "guild-1",
      sourceSyncedAt: null,
      latestSourceSyncedAt: null,
      trackedClanTags: ["#RR"],
      eligibleClanTags: ["#RR"],
      heatMapRefs: [],
      clans: [{
        clanTag: "#RR",
        clanName: "Rocky Road",
        shortName: "RR",
        base: {
          resolvedTotalWeight: 145000,
          unresolvedWeightCount: 0,
          missingTo50Count: 0,
          memberCount: 50,
        },
        members: [],
      }],
    } as any);
    vi.spyOn(CompoReplacementService.prototype, "resolveReplacementCandidates").mockResolvedValue({
      inputWeight: 145000,
      bucket: "TH15",
      summaryByClan: [{
        clanTag: "#RR",
        clanName: "Rocky Road",
        uniqueCandidateCount: 1,
        fillerCount: 0,
        inactiveCount: 0,
        unlinkedCount: 0,
        surplusCount: 1,
      }],
      candidates: [{
        clanTag: "#RR",
        clanName: "Rocky Road",
        playerTag: "#D4",
        playerName: "Drew",
        resolvedWeight: 146000,
        resolvedBucket: "TH15",
        discordUserId: "789",
        discordMention: "<@789>",
        inactiveLabel: null,
        surplusDelta: 1,
        violationCount30d: 0,
        reasons: { filler: false, inactive: false, unlinked: false, surplus: true },
      }],
    } as any);
    const interaction: any = {
      customId: "compo-replacements:open:user-1:145000",
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCompoReplacementButton(interaction as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = getEmbedJSON(payload);
    expect(String(embed?.description ?? "")).toContain("No candidates match the current filters.");
    expect(String(embed?.description ?? "")).toContain("Showing 0 of 1 candidates");
    expect(payload?.components).toHaveLength(5);
  });

  it("rejects replacement explorer interactions from another user", async () => {
    const interaction: any = {
      customId: "compo-replacements:rs:user-1:145000",
      guildId: "guild-1",
      user: { id: "user-2" },
      deferred: false,
      replied: false,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCompoReplacementButton(interaction as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this replacements button.",
    });
  });

  it("renders an unlinked replacement row without a mention", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      guildId: "guild-1",
      sourceSyncedAt: null,
      latestSourceSyncedAt: null,
      trackedClanTags: ["#RR"],
      eligibleClanTags: ["#RR"],
      heatMapRefs: [],
      clans: [
        {
          clanTag: "#RR",
          clanName: "Rocky Road",
          shortName: "RR",
          base: {
            resolvedTotalWeight: 145000,
            unresolvedWeightCount: 0,
            missingTo50Count: 0,
            memberCount: 50,
          },
          members: [],
        },
      ],
    } as any);
    vi.spyOn(CompoReplacementService.prototype, "resolveReplacementCandidates").mockResolvedValue({
      inputWeight: 145000,
      bucket: "TH15",
      summaryByClan: [
        {
          clanTag: "#RR",
          clanName: "Rocky Road",
          uniqueCandidateCount: 1,
          fillerCount: 0,
          inactiveCount: 0,
          unlinkedCount: 1,
        },
      ],
      candidates: [
        {
          clanTag: "#RR",
          clanName: "Rocky Road",
          playerTag: "#U1",
          playerName: "Una",
          resolvedWeight: 146000,
          resolvedBucket: "TH15",
          discordUserId: null,
          discordMention: null,
          inactiveLabel: null,
          reasons: { filler: false, inactive: false, unlinked: true },
        },
      ],
    } as any);

    const interaction: any = {
      customId: "compo-replacements:vw:user-1:145000:0:-:a:0:0",
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleCompoReplacementButton } = await import("../src/commands/Compo");
    await handleCompoReplacementButton(interaction as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = getEmbedJSON(payload);
    expect(String(embed?.description ?? "")).toContain("Una — 146k — 📵 unlinked");
    expect(String(embed?.description ?? "")).not.toContain("<@");
  });

  it("paginates replacement drill-down rows and advances pages", async () => {
    vi.spyOn(actualStateService, "loadCompoActualStateContext").mockResolvedValue({
      guildId: "guild-1",
      sourceSyncedAt: null,
      latestSourceSyncedAt: null,
      trackedClanTags: ["#RR"],
      eligibleClanTags: ["#RR"],
      heatMapRefs: [],
      clans: [
        {
          clanTag: "#RR",
          clanName: "Rocky Road",
          shortName: "RR",
          base: {
            resolvedTotalWeight: 145000,
            unresolvedWeightCount: 0,
            missingTo50Count: 0,
            memberCount: 50,
          },
          members: [],
        },
      ],
    } as any);

    const candidates = Array.from({ length: 90 }, (_value, index) => {
      const playerIndex = String(index + 1).padStart(3, "0");
      return {
        clanTag: "#RR",
        clanName: "Rocky Road",
        playerTag: `#P${playerIndex}`,
        playerName: `Player ${playerIndex}`,
        resolvedWeight: 145000,
        resolvedBucket: "TH15",
        discordUserId: index % 2 === 0 ? `${1000 + index}` : null,
        discordMention: index % 2 === 0 ? `<@${1000 + index}>` : null,
        inactiveLabel: index % 3 === 0 ? "6d" : null,
        reasons: {
          filler: true,
          inactive: index % 3 === 0,
          unlinked: index % 2 === 1,
        },
      };
    });
    vi.spyOn(CompoReplacementService.prototype, "resolveReplacementCandidates").mockResolvedValue({
      inputWeight: 145000,
      bucket: "TH15",
      summaryByClan: [
        {
          clanTag: "#RR",
          clanName: "Rocky Road",
          uniqueCandidateCount: candidates.length,
          fillerCount: candidates.length,
          inactiveCount: Math.ceil(candidates.length / 3),
          unlinkedCount: Math.floor(candidates.length / 2),
        },
      ],
      candidates,
    } as any);

    const { handleCompoReplacementButton } = await import("../src/commands/Compo");
    const openInteraction: any = {
      customId: "compo-replacements:open:user-1:145000",
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        openInteraction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCompoReplacementButton(openInteraction as any);

    const firstPayload = openInteraction.editReply.mock.calls.at(-1)?.[0];
    const firstEmbed = getEmbedJSON(firstPayload);
    expect(String(firstEmbed?.footer?.text ?? "")).toMatch(/Page 1\/[2-9]\d*/);
    expect(getComponentCustomIds(firstPayload).slice(-2)).toEqual([
      "compo-replacements:pg:user-1:145000:0:-:p:0:0:b",
      "compo-replacements:pg:user-1:145000:0:-:p:0:0:n",
    ]);

    const nextInteraction: any = {
      customId: "compo-replacements:pg:user-1:145000:0:-:p:0:0:n",
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        nextInteraction.deferred = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCompoReplacementButton(nextInteraction as any);

    const nextPayload = nextInteraction.editReply.mock.calls.at(-1)?.[0];
    const nextEmbed = getEmbedJSON(nextPayload);
    expect(String(nextEmbed?.footer?.text ?? "")).toMatch(/Page 2\/[2-9]\d*/);
    expect(String(nextEmbed?.description ?? "")).toContain("Player 021");
  });

  it("round-trips compact replacement explorer state and keeps IDs under Discord's limit", () => {
    const state = {
      userId: "123456789012345678",
      weight: 175000,
      page: 42,
      clanTag: "RR1234",
      view: "all" as const,
      types: ["filler", "inactive", "unlinked", "surplus", "violations"] as const,
      minimumViolations: 5,
    };
    const pageId = buildCompoReplacementCustomIdForTest({
      kind: "page",
      state,
      direction: "next",
    } as any);
    expect(pageId.length).toBeLessThanOrEqual(100);
    expect(parseCompoReplacementCustomIdForTest(pageId)).toEqual({
      kind: "page",
      state: { ...state, types: [...state.types] },
      direction: "next",
    });

    const selectId = buildCompoReplacementSelectCustomIdForTest({
      field: "type",
      state,
    } as any);
    expect(selectId.length).toBeLessThanOrEqual(100);
    expect(parseCompoReplacementSelectCustomIdForTest(selectId)).toEqual({
      kind: "select",
      field: "type",
      state: { ...state, types: [...state.types] },
    });
  });
});
