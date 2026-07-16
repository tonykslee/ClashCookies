import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";
import { buildFwaMatchBasesMessageContent } from "../src/services/FwaMatchChecklistService";
import { repWorkActivityService } from "../src/services/RepWorkActivityService";

function makeBasesTrackedChecklistRow() {
  return {
    id: "tracked-bases-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "bases-message-1",
    featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: "sync-message-1",
    clanTag: "#PYPY",
    expiresAt: new Date("2030-06-13T22:00:00.000Z"),
    createdAt: new Date("2026-06-13T17:00:00.000Z"),
    metadata: {
      kind: "bases_checklist",
      createdByUserId: "user-1",
      createdAtIso: "2026-06-13T17:00:00.000Z",
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
      checkedClanTags: [],
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-06-13T18:00:00.000Z",
          detailLines: null,
          basesStatus: "not_checked",
          contextKey: "ctx-alpha",
        },
      ],
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "bases-message-1",
      clanTag: "#PYPY",
      warId: 1001,
      opponentTag: "#OPP1",
      warStartTimeIso: "2026-06-13T18:00:00.000Z",
    },
  };
}

function makeBasesRow(params: {
  clanTag: string;
  compactCopyLine: string;
  badgeEmojiInline: string;
  badgeEmojiId: string | null;
  badgeEmojiName: string | null;
  basesStatus?: string;
  warId?: number | null;
  opponentTag?: string | null;
  warStartTimeIso?: string | null;
  contextKey?: string | null;
}) {
  return {
    ...makeBasesTrackedChecklistRow().metadata.rows[0],
    clanTag: params.clanTag,
    compactCopyLine: params.compactCopyLine,
    badgeEmojiInline: params.badgeEmojiInline,
    badgeEmojiId: params.badgeEmojiId,
    badgeEmojiName: params.badgeEmojiName,
    basesStatus: params.basesStatus ?? "not_checked",
    warId: params.warId ?? 1001,
    opponentTag: params.opponentTag ?? "#OPP1",
    warStartTimeIso: params.warStartTimeIso ?? "2026-06-13T18:00:00.000Z",
    contextKey: params.contextKey ?? "ctx-reconcile",
  };
}

function makeReactionCacheEntry(params: {
  emojiInline: string;
  count?: number;
  me?: boolean | null;
}) {
  const trimmed = String(params.emojiInline ?? "").trim();
  const custom = /^<a?:([A-Za-z0-9_]{2,32}):(\d{1,22})>$/.exec(trimmed);
  const key = custom ? `custom:${custom[2]}` : `unicode:${trimmed.normalize("NFC")}`;
  return [
    key,
    {
      emoji: custom
        ? { id: custom[2] ?? null, name: custom[1] ?? null }
        : { id: null, name: trimmed },
      count: params.count ?? 1,
      me: params.me ?? false,
    },
  ] as const;
}

function makeRefreshMessage(params: {
  id: string;
  reactionEntries?: Array<{
    emojiInline: string;
    count?: number;
    me?: boolean | null;
  }>;
  partial?: boolean;
  reactFailures?: string[];
}) {
  const reactionCache = new Map(
    (params.reactionEntries ?? []).map((entry) => makeReactionCacheEntry(entry)),
  );
  const fetch = vi.fn().mockResolvedValue({
    id: params.id,
    reactions: {
      cache: reactionCache,
    },
  });
  const reactFailures = new Set((params.reactFailures ?? []).map((emoji) => String(emoji ?? "").trim()));
  const react = vi.fn().mockImplementation(async (emoji: string) => {
    const trimmed = String(emoji ?? "").trim();
    if (reactFailures.has(trimmed)) {
      throw new Error(`react failed for ${trimmed}`);
    }
    const existing = reactionCache.get(makeReactionCacheEntry({ emojiInline: trimmed })[0]) as
      | { emoji: { id: string | null; name: string | null }; count?: number | null; me?: boolean | null }
      | undefined;
    const custom = /^<a?:([A-Za-z0-9_]{2,32}):(\d{1,22})>$/.exec(trimmed);
    reactionCache.set(makeReactionCacheEntry({ emojiInline: trimmed })[0], {
      emoji: custom
        ? { id: custom[2] ?? null, name: custom[1] ?? null }
        : { id: null, name: trimmed },
      count: (existing?.count ?? 0) + 1,
      me: true,
    });
    return undefined;
  });
  const edit = vi.fn().mockResolvedValue(undefined);
  const message = {
    id: params.id,
    partial: params.partial ?? false,
    fetch,
    react,
    reactions: {
      cache: reactionCache,
    },
    edit,
  };
  return {
    message,
    fetch,
    react,
    edit,
    reactionCache,
  };
}

describe("fwa checklist badge reaction reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(
      null,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue(null);
    vi.spyOn(repWorkActivityService, "recordBasesChecklistChecked").mockResolvedValue(true);
  });

  it("repairs newly eligible rows on a listener refresh from final rows", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeBasesTrackedChecklistRow(),
      metadata: {
        ...makeBasesTrackedChecklistRow().metadata,
        rows: [
          makeBasesRow({
            clanTag: "#PYPY",
            compactCopyLine: "Alpha | 🔘 | Skipped this sync 😴",
            badgeEmojiInline: "<:alpha:111>",
            badgeEmojiId: "111",
            badgeEmojiName: "alpha",
            basesStatus: "skipped",
            warId: null,
            opponentTag: null,
            warStartTimeIso: null,
            contextKey: null,
          }),
        ],
      },
    } as any);

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { message, fetch, react, edit } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [],
    });

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, {
        kind: "add",
        reaction: {
          emoji: { id: "111", name: "alpha" },
          count: 1,
        },
      } as any),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:alpha:111>");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls.at(-1)?.[0]?.content).toBe(
      buildFwaMatchBasesMessageContent({ rows: finalRows as any }),
    );
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("event=reaction_reconcile"));
  });

  it("repairs the same missing reaction on a button refresh through the shared path", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, react, edit } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [],
    });

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, null, {
        rows: finalRows as any,
        scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
        expiresAt: new Date("2026-06-13T22:00:00.000Z"),
      }),
    ).resolves.toBe(true);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:alpha:111>");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls.at(-1)?.[0]?.content).toBe(
      buildFwaMatchBasesMessageContent({ rows: finalRows as any }),
    );
  });

  it("stays idempotent when all bot badge reactions already exist", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, fetch, react, edit } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [
        {
          emojiInline: "<:alpha:111>",
          count: 1,
          me: true,
        },
      ],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);
    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(fetch).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls.at(-1)?.[0]?.content).toBe(
      buildFwaMatchBasesMessageContent({ rows: finalRows as any }),
    );
  });

  it("adds only the missing bot reactions when some existing reactions are already present", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
      makeBasesRow({
        clanTag: "#TWC",
        compactCopyLine: "Bravo | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:bravo:222>",
        badgeEmojiId: "222",
        badgeEmojiName: "bravo",
        contextKey: "ctx-bravo",
      }),
      makeBasesRow({
        clanTag: "#RR",
        compactCopyLine: "Charlie | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:charlie:333>",
        badgeEmojiId: "333",
        badgeEmojiName: "charlie",
        contextKey: "ctx-charlie",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, react } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [
        {
          emojiInline: "<:alpha:111>",
          count: 1,
          me: true,
        },
        {
          emojiInline: "<:charlie:333>",
          count: 1,
          me: true,
        },
      ],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:bravo:222>");
  });

  it("does not confuse a user-only reaction for a bot reaction", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, react, reactionCache } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [
        {
          emojiInline: "<:alpha:111>",
          count: 1,
          me: false,
        },
      ],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:alpha:111>");
    expect(reactionCache.get("custom:111")).toMatchObject({
      me: true,
    });
  });

  it("skips skipped rows and logs invalid badge config without aborting", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
      makeBasesRow({
        clanTag: "#SKIP",
        compactCopyLine: "Skip | 🔘 | Skipped this sync 😴",
        badgeEmojiInline: "<:skip:222>",
        badgeEmojiId: "222",
        badgeEmojiName: "skip",
        basesStatus: "skipped",
        warId: null,
        opponentTag: null,
        warStartTimeIso: null,
        contextKey: null,
      }),
      makeBasesRow({
        clanTag: "#BAD",
        compactCopyLine: "Bad | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "not-a-real-emoji",
        badgeEmojiId: null,
        badgeEmojiName: null,
        contextKey: "ctx-bad",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { message, react } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:alpha:111>");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failure=invalid_emoji_config"),
    );
  });

  it("keeps later badge reactions moving when one reaction add fails", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
      makeBasesRow({
        clanTag: "#TWC",
        compactCopyLine: "Bravo | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:bravo:222>",
        badgeEmojiId: "222",
        badgeEmojiName: "bravo",
        contextKey: "ctx-bravo",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { message, react, edit } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [],
      reactFailures: ["<:alpha:111>"],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(react).toHaveBeenCalledTimes(2);
    expect(react.mock.calls.map((call) => call[0])).toEqual(["<:alpha:111>", "<:bravo:222>"]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failure=unknown_error"));
  });

  it("matches both Unicode and custom emoji against existing bot reactions", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "🔥",
        badgeEmojiId: null,
        badgeEmojiName: "🔥",
      }),
      makeBasesRow({
        clanTag: "#TWC",
        compactCopyLine: "Bravo | ⚫ | ❌ Bases not checked",
        badgeEmojiInline: "<:bravo:222>",
        badgeEmojiId: "222",
        badgeEmojiName: "bravo",
        contextKey: "ctx-bravo",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, fetch, react } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [
        {
          emojiInline: "🔥",
          count: 1,
          me: true,
        },
        {
          emojiInline: "<:bravo:222>",
          count: 1,
          me: true,
        },
      ],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(fetch).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });

  it("keeps custom emoji identities exact even when the names match", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | âš« | âŒ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, react } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [
        {
          emojiInline: "<:alpha:222>",
          count: 1,
          me: true,
        },
      ],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:alpha:111>");
  });

  it("treats an empty fetched reaction cache as a normal empty refresh", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | âš« | âŒ Bases not checked",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { message, fetch, react } = makeRefreshMessage({
      id: "bases-message-1",
      partial: true,
      reactionEntries: [],
    });
    fetch.mockResolvedValueOnce({
      id: "bases-message-1",
      reactions: {
        cache: new Map(),
      },
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("<:alpha:111>");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does no reaction work when the final checklist rows have no eligible badges", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeBasesTrackedChecklistRow(),
      metadata: {
        ...makeBasesTrackedChecklistRow().metadata,
        rows: [
          makeBasesRow({
            clanTag: "#PYPY",
            compactCopyLine: "Skip | 🔘 | Skipped this sync 😴",
            badgeEmojiInline: "<:alpha:111>",
            badgeEmojiId: "111",
            badgeEmojiName: "alpha",
            basesStatus: "skipped",
            warId: null,
            opponentTag: null,
            warStartTimeIso: null,
            contextKey: null,
          }),
        ],
      },
    } as any);

    const finalRows = [
      makeBasesRow({
        clanTag: "#PYPY",
        compactCopyLine: "Skip | 🔘 | Skipped this sync 😴",
        badgeEmojiInline: "<:alpha:111>",
        badgeEmojiId: "111",
        badgeEmojiName: "alpha",
        basesStatus: "skipped",
        warId: null,
        opponentTag: null,
        warStartTimeIso: null,
        contextKey: null,
      }),
    ];
    const stateServiceModule = await import("../src/services/FwaMatchChecklistStateService");
    vi.spyOn(stateServiceModule, "buildFwaMatchChecklistRenderStateForGuild").mockResolvedValue({
      rows: finalRows,
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-reconcile",
      expiresAt: new Date("2026-06-13T22:00:00.000Z"),
    } as any);

    const { message, fetch, react, edit } = makeRefreshMessage({
      id: "bases-message-1",
      reactionEntries: [],
    });

    await expect(trackedMessageService.refreshFwaMatchChecklistMessage(message as any)).resolves.toBe(true);

    expect(fetch).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls.at(-1)?.[0]?.content).toBe(
      buildFwaMatchBasesMessageContent({ rows: finalRows as any }),
    );
  });
});
