import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
  },
}));

const botLogChannelServiceMock = vi.hoisted(() => ({
  getChannelIdForType: vi.fn(),
  clearChannelIdForType: vi.fn(),
}));

const renderStateMock = vi.hoisted(() => ({
  buildFwaMatchChecklistRenderStateForGuild: vi.fn(),
}));

const publishMock = vi.hoisted(() => ({
  publishFwaMatchChecklistMessageToChannel: vi.fn(),
}));

const SYNC_EPOCH_SECONDS = Math.floor(
  new Date("2026-05-13T00:00:00.000Z").getTime() / 1000,
);
const SYNC_FALLBACK_EXPIRES_AT = new Date(
  (SYNC_EPOCH_SECONDS * 1000) + 48 * 60 * 60 * 1000,
);

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/BotLogChannelService", () => ({
  BotLogChannelService: vi.fn().mockImplementation(() => botLogChannelServiceMock),
}));

vi.mock("../src/services/CoCService", () => ({
  CoCService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/services/FwaMatchChecklistStateService", () => ({
  buildFwaMatchChecklistRenderStateForGuild:
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild,
}));

vi.mock("../src/services/FwaMatchChecklistService", () => ({
  publishFwaMatchChecklistMessageToChannel:
    publishMock.publishFwaMatchChecklistMessageToChannel,
}));

import { FwaMatchChecklistAutoPostService } from "../src/services/fwa/matchChecklistAutoPostService";
import { trackedMessageService } from "../src/services/TrackedMessageService";

function makeClient(input?: {
  channel?: unknown | null;
  fetchError?: unknown;
}) {
  const fetch = input?.fetchError
    ? vi.fn().mockRejectedValue(input.fetchError)
    : vi.fn().mockResolvedValue(input?.channel ?? null);
  return {
    guilds: {
      fetch: vi.fn().mockResolvedValue({
        id: "guild-1",
        channels: {
          fetch,
        },
      }),
    },
  } as any;
}

function makeChecklistChannel() {
  return {
    id: "checklist-channel",
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send: vi.fn(),
  };
}

function makeBasesChecklistRows(params?: {
  skippedCount?: number;
  total?: number;
}) {
  const skippedCount = params?.skippedCount ?? 0;
  const total = params?.total ?? 9;
  return Array.from({ length: total }, (_, index) => {
    const clanIndex = index + 1;
    return {
      clanTag: `#CLAN${clanIndex}`,
      compactCopyLine: `Clan ${clanIndex} | ⚫ | ${index < skippedCount ? "❌ Bases not checked" : "✅ Bases checked and all good"}`,
      badgeEmojiId: String(100 + clanIndex),
      badgeEmojiName: `badge_${clanIndex}`,
      badgeEmojiInline: `<:badge_${clanIndex}:${100 + clanIndex}>`,
      basesStatus: index < skippedCount ? "skipped" : "all_good",
      matchType: "FWA",
      warId: 1000 + clanIndex,
      opponentTag: `#OPP${clanIndex}`,
      warStartTimeIso: "2026-05-13T18:00:00.000Z",
    } as const;
  });
}

function makeProductionBasesChecklistRows() {
  return [
    {
      clanTag: "#2YUYLJCGV",
      compactCopyLine: "RD | 🟢 | ❌ Bases not checked",
      badgeEmojiId: "1363320268755435772",
      badgeEmojiName: "Logo_RisingDawn",
      badgeEmojiInline: "<:Logo_RisingDawn:1363320268755435772>",
      basesStatus: "skipped",
      matchType: "UNKNOWN",
      warId: null,
      opponentTag: null,
      warStartTimeIso: null,
    },
    {
      clanTag: "#LQQ99UV8",
      compactCopyLine: "ZG | 🔴 | ❌ Bases not checked",
      badgeEmojiId: "1363320272035385524",
      badgeEmojiName: "Logo_ZeroGravity",
      badgeEmojiInline: "<:Logo_ZeroGravity:1363320272035385524>",
      basesStatus: "skipped",
      matchType: "UNKNOWN",
      warId: null,
      opponentTag: null,
      warStartTimeIso: null,
    },
    {
      clanTag: "#R80L8VYG",
      compactCopyLine: "DE | 🟢 | ❌ Bases not checked",
      badgeEmojiId: "1363320285595435148",
      badgeEmojiName: "Logo_DarkEmpire",
      badgeEmojiInline: "<:Logo_DarkEmpire:1363320285595435148>",
      basesStatus: "skipped",
      matchType: "UNKNOWN",
      warId: null,
      opponentTag: null,
      warStartTimeIso: null,
    },
    {
      clanTag: "#82YLR9Q2",
      compactCopyLine: "SE | 🟢 | ❌ Bases not checked",
      badgeEmojiId: "1463680051261341799",
      badgeEmojiName: "Logo_SteelEmpire",
      badgeEmojiInline: "<:Logo_SteelEmpire:1463680051261341799>",
      basesStatus: "not_checked",
      matchType: "FWA",
      warId: 1000627,
      opponentTag: "#2PV0CC98V",
      warStartTimeIso: "2026-07-16T20:08:41.000Z",
    },
    {
      clanTag: "#29PCQGUV0",
      compactCopyLine: "TWC | 🔴 | ❌ Bases not checked",
      badgeEmojiId: "1367885051622195230",
      badgeEmojiName: "Logo_TheWiseCowboys",
      badgeEmojiInline: "<:Logo_TheWiseCowboys:1367885051622195230>",
      basesStatus: "skipped",
      matchType: "UNKNOWN",
      warId: null,
      opponentTag: null,
      warStartTimeIso: null,
    },
    {
      clanTag: "#2RYGLU2UY",
      compactCopyLine: "RR | 🔴 | ❌ Bases not checked",
      badgeEmojiId: "1463679964334526495",
      badgeEmojiName: "Logo_RockyRoad",
      badgeEmojiInline: "<:Logo_RockyRoad:1463679964334526495>",
      basesStatus: "not_checked",
      matchType: "FWA",
      warId: null,
      opponentTag: "#2J02UUJ8U",
      warStartTimeIso: "2026-07-16T20:00:41.000Z",
    },
    {
      clanTag: "#2RVV0L0VP",
      compactCopyLine: "AK | 🟢 | ❌ Bases not checked",
      badgeEmojiId: "1464436468578517125",
      badgeEmojiName: "Logo_Akatsuki",
      badgeEmojiInline: "<:Logo_Akatsuki:1464436468578517125>",
      basesStatus: "not_checked",
      matchType: "FWA",
      warId: 1000626,
      opponentTag: "#2C90QQ0Q9",
      warStartTimeIso: "2026-07-16T20:06:51.000Z",
    },
    {
      clanTag: "#C0CU2Q82",
      compactCopyLine: "SH | 🟢 | ❌ Bases not checked",
      badgeEmojiId: "1496617661264695296",
      badgeEmojiName: "Logo_StrawHats",
      badgeEmojiInline: "<:Logo_StrawHats:1496617661264695296>",
      basesStatus: "skipped",
      matchType: "UNKNOWN",
      warId: null,
      opponentTag: null,
      warStartTimeIso: null,
    },
    {
      clanTag: "#2QVGPQP0U",
      compactCopyLine: "EB | 🟢 | ❌ Bases not checked",
      badgeEmojiId: "1496617820115435702",
      badgeEmojiName: "Logo_EternalBlaze",
      badgeEmojiInline: "<:Logo_EternalBlaze:1496617820115435702>",
      basesStatus: "skipped",
      matchType: "UNKNOWN",
      warId: null,
      opponentTag: null,
      warStartTimeIso: null,
    },
  ] as const;
}

describe("FwaMatchChecklistAutoPostService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    botLogChannelServiceMock.getChannelIdForType.mockResolvedValue("checklist-channel");
    botLogChannelServiceMock.clearChannelIdForType.mockResolvedValue(undefined);
    publishMock.publishFwaMatchChecklistMessageToChannel.mockResolvedValue({
      messageId: "posted-message",
      sent: true,
      finalized: true,
    });
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockImplementation(
      async ({
        viewType,
        fallbackExpiresAt,
      }: {
        viewType?: "Mail" | "Bases";
        fallbackExpiresAt?: Date | null;
      }) => ({
        viewType: viewType ?? "Mail",
        rows: [
          {
            clanTag: "#PYPY",
            compactCopyLine:
              (viewType ?? "Mail") === "Bases"
                ? "Alpha | ⚫ | ❌ Bases not checked"
                : "📬 | 🟢 | Alpha vs `Bravo` (`#B1`)",
            badgeEmojiId: "111",
            badgeEmojiName: "rr",
            badgeEmojiInline: "<:rr:111>",
          },
        ],
        scopeKey: `${viewType ?? "Mail"}-scope`,
        checkedClanTags: [],
        referenceId: "sync-message-1",
        expiresAt:
          fallbackExpiresAt ?? new Date("2026-05-13T00:30:00.000Z"),
        emptyMessage: null,
      }),
    );
    vi.spyOn(trackedMessageService, "claimFwaMatchChecklistPublication").mockResolvedValue({
      claimed: true,
      claimKey: "claim-key",
      sourceTrackedMessageId: "source-tracked-message-id",
    });
    vi.spyOn(
      trackedMessageService,
      "findFwaMatchChecklistPublicationBySyncReference",
    ).mockResolvedValue(null);
    vi.spyOn(
      trackedMessageService,
      "releaseFwaMatchChecklistPublicationClaim",
    ).mockResolvedValue(true);
  });

  it("posts only the Mail checklist when requested", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(botLogChannelServiceMock.getChannelIdForType).toHaveBeenCalledWith(
      "guild-1",
      "checklist",
    );
    expect(cocFactory).toHaveBeenCalledTimes(1);
    expect(renderStateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", viewType: "Mail" }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
        channel,
        guildId: "guild-1",
        channelId: "checklist-channel",
        referenceId: "sync-message-1",
      }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
  });

  it("uses a sync-based fallback expiry when war timing is still unknown", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
      },
      createdByUserId: "user-1",
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(renderStateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        viewType: "Mail",
        fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
      }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
        referenceId: "sync-message-1",
        expiresAt: SYNC_FALLBACK_EXPIRES_AT,
      }),
    );
  });

  it("passes the exact unknown mail row through the automatic-post path", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Mail",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "📭 | 🔘 | ☐ | Alpha vs `-`",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
        },
      ],
      scopeKey: "mail-unknown-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
      emptyMessage: null,
    });

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
        referenceId: "sync-message-1",
        rows: [
          expect.objectContaining({
            compactCopyLine: "📭 | 🔘 | ☐ | Alpha vs `-`",
          }),
        ],
      }),
    );
  });

  it("preserves a known war-end expiry when render state already knows it", async () => {
    const knownWarEnd = new Date("2026-05-14T22:00:00.000Z");
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | âš« | âŒ Bases not checked",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
        },
      ],
      scopeKey: "Bases-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: knownWarEnd,
      emptyMessage: null,
    });

    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
      },
      createdByUserId: "user-1",
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
        referenceId: "sync-message-1",
        expiresAt: knownWarEnd,
      }),
    );
  });

  it("posts only the Bases checklist when requested", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(cocFactory).toHaveBeenCalledTimes(1);
    expect(renderStateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", viewType: "Bases" }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
        channel,
        guildId: "guild-1",
        channelId: "checklist-channel",
        referenceId: "sync-message-1",
      }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
  });

  it("blocks Bases publication while skipped rows are still inside the readiness grace window", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: makeBasesChecklistRows({ skippedCount: 6 }),
      scopeKey: "Bases-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
      emptyMessage: null,
    });

    try {
      const result = await service.postForSyncTrackedMessage({
        client: makeClient({ channel }),
        tracked: {
          guildId: "guild-1",
          channelId: "source-channel",
          messageId: "sync-message-1",
          expiresAt: new Date("2026-05-13T01:00:00.000Z"),
          checklistDueAt: new Date("2026-05-13T00:02:00.000Z"),
        },
        createdByUserId: "user-1",
        viewType: "Bases",
        nowMs: new Date("2026-05-13T00:10:00.000Z").getTime(),
      });

      expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
      expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).toHaveBeenCalledWith({
        sourceTrackedMessageId: "source-tracked-message-id",
        claimKey: "claim-key",
      });
      expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
      expect(
        infoSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("reason=bases_not_ready") &&
          String(call[0] ?? "").includes("skippedCount=6") &&
          String(call[0] ?? "").includes("expectedReactionCount=3") &&
          String(call[0] ?? "").includes("trackedClanCount=9"),
        ),
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("allows Bases publication when all rows are ready", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: makeBasesChecklistRows({ skippedCount: 0 }),
      scopeKey: "Bases-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
      emptyMessage: null,
    });

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
        checklistDueAt: new Date("2026-05-13T00:02:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Bases",
      nowMs: new Date("2026-05-13T00:10:00.000Z").getTime(),
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
  });

  it("allows Bases publication after the readiness grace window expires", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const basesRows = makeBasesChecklistRows({ skippedCount: 6 });
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: basesRows,
      scopeKey: "Bases-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
      emptyMessage: null,
    });

    try {
      const result = await service.postForSyncTrackedMessage({
        client: makeClient({ channel }),
        tracked: {
          guildId: "guild-1",
          channelId: "source-channel",
          messageId: "sync-message-1",
          expiresAt: new Date("2026-05-13T01:00:00.000Z"),
          checklistDueAt: new Date("2026-05-13T00:02:00.000Z"),
        },
        createdByUserId: "user-1",
        viewType: "Bases",
        nowMs: new Date("2026-05-13T00:20:30.000Z").getTime(),
      });

      expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
      expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          viewType: "Bases",
          rows: basesRows,
        }),
      );
      expect(
        infoSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("reason=bases_ready_gate_expired") &&
          String(call[0] ?? "").includes("skippedCount=6"),
        ),
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("reproduces the July 15 nine-clan readiness-gate shape", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: makeProductionBasesChecklistRows(),
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=production",
      checkedClanTags: [],
      referenceId: "1526856991119769693",
      expiresAt: new Date("2026-07-15T22:00:00.000Z"),
      emptyMessage: null,
    });

    try {
      const result = await service.postForSyncTrackedMessage({
        client: makeClient({ channel }),
        tracked: {
          guildId: "guild-1",
          channelId: "source-channel",
          messageId: "1526856991119769693",
          expiresAt: new Date("2026-07-15T22:00:00.000Z"),
          checklistDueAt: new Date("2026-07-15T21:02:00.000Z"),
        },
        createdByUserId: "user-1",
        viewType: "Bases",
        nowMs: new Date("2026-07-15T21:17:46.176Z").getTime(),
      });

      expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
      expect(
        infoSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("reason=bases_ready_gate_expired") &&
          String(call[0] ?? "").includes("skippedCount=6") &&
          String(call[0] ?? "").includes("expectedReactionCount=3") &&
          String(call[0] ?? "").includes("trackedClanCount=9") &&
          String(call[0] ?? "").includes("gateExpiresAt=2026-07-15T21:17:00.000Z"),
        ),
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not apply the Bases readiness gate to Mail auto-posts", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Mail",
      rows: makeBasesChecklistRows({ skippedCount: 6 }),
      scopeKey: "Mail-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
      emptyMessage: null,
    });

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
        checklistDueAt: new Date("2026-05-13T00:02:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Mail",
      nowMs: new Date("2026-05-13T00:10:00.000Z").getTime(),
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
  });

  it("skips without throwing when no checklist channel is configured", async () => {
    botLogChannelServiceMock.getChannelIdForType.mockResolvedValue(null);
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(cocFactory).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("clears only checklist config when the configured channel is missing", async () => {
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: null }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(cocFactory).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.clearChannelIdForType).toHaveBeenCalledWith(
      "guild-1",
      "checklist",
    );
    expect(botLogChannelServiceMock.clearChannelIdForType).not.toHaveBeenCalledWith(
      "guild-1",
      "sync",
    );
  });

  it("does not clear config when the configured channel is inaccessible", async () => {
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ fetchError: { code: 50013 } }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(cocFactory).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.clearChannelIdForType).not.toHaveBeenCalled();
  });

  it("does not duplicate the Mail checklist for the same sync identity", async () => {
    vi.mocked(trackedMessageService.claimFwaMatchChecklistPublication).mockResolvedValueOnce({
      claimed: false,
      claimKey: "claim-key",
      sourceTrackedMessageId: "source-tracked-message-id",
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const client = makeClient({ channel: makeChecklistChannel() });

    const result = await service.postForSyncTrackedMessage({
      client,
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.guilds.fetch).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.getChannelIdForType).not.toHaveBeenCalled();
    expect(cocFactory).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("does not duplicate the Bases checklist for the same sync identity", async () => {
    vi.mocked(trackedMessageService.claimFwaMatchChecklistPublication).mockResolvedValueOnce({
      claimed: false,
      claimKey: "claim-key",
      sourceTrackedMessageId: "source-tracked-message-id",
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const client = makeClient({ channel: makeChecklistChannel() });

    const result = await service.postForSyncTrackedMessage({
      client,
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.guilds.fetch).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.getChannelIdForType).not.toHaveBeenCalled();
    expect(cocFactory).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("skips when an existing checklist row is already stored for the same source sync and kind", async () => {
    vi.mocked(
      trackedMessageService.findFwaMatchChecklistPublicationBySyncReference,
    ).mockResolvedValueOnce({
      id: "tracked-checklist-1",
      messageId: "message-1",
      referenceId: "sync-message-1",
      status: "ACTIVE",
      metadata: {
        kind: "mail_checklist",
      },
    } as any);
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
  });

  it("blocks reposting when the prior checklist row was deleted", async () => {
    vi.mocked(
      trackedMessageService.findFwaMatchChecklistPublicationBySyncReference,
    ).mockResolvedValueOnce({
      id: "tracked-checklist-1",
      messageId: "deleted-message-1",
      referenceId: "sync-message-1",
      status: "DELETED",
      metadata: {
        kind: "mail_checklist",
      },
    } as any);
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
  });

  it("releases the claim when Discord send fails before persistence", async () => {
    publishMock.publishFwaMatchChecklistMessageToChannel.mockResolvedValueOnce({
      messageId: null,
      sent: false,
      finalized: false,
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).toHaveBeenCalledWith({
      sourceTrackedMessageId: "source-tracked-message-id",
      claimKey: "claim-key",
    });
  });

  it("retains the claim when send succeeds but persistence fails", async () => {
    publishMock.publishFwaMatchChecklistMessageToChannel.mockResolvedValueOnce({
      messageId: "posted-message",
      sent: true,
      finalized: false,
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when checklist rendering fails before send", async () => {
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockRejectedValueOnce(
      new Error("COC_QUEUE_CONTEXT_MISSING:getCurrentWar"),
    );
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).toHaveBeenCalledWith({
      sourceTrackedMessageId: "source-tracked-message-id",
      claimKey: "claim-key",
    });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("can import the singleton without constructing the real CoC service", async () => {
    vi.resetModules();
    vi.doUnmock("../src/services/CoCService");
    const originalToken = process.env.COC_API_TOKEN;
    delete process.env.COC_API_TOKEN;
    try {
      await expect(
        import("../src/services/fwa/matchChecklistAutoPostService"),
      ).resolves.toHaveProperty("fwaMatchChecklistAutoPostService");
    } finally {
      if (originalToken === undefined) {
        delete process.env.COC_API_TOKEN;
      } else {
        process.env.COC_API_TOKEN = originalToken;
      }
    }
  });
});
