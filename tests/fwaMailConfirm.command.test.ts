import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  currentWar: {
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildFwaMailConfirmCustomId,
  buildFwaMailConfirmNoPingCustomId,
} from "../src/commands/fwa/customIds";
import {
  clearFwaMailPreviewPayloadsForTest,
  getFwaMailPreviewPayloadForTest,
  handleFwaMailConfirmButton,
  handleFwaMailConfirmNoPingButton,
  resetFwaMailConfirmRerenderForTest,
  setFwaMailConfirmRerenderForTest,
  setFwaMailPreviewPayloadForTest,
} from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";
import { RepWorkActivityService } from "../src/services/RepWorkActivityService";
import { WarEventLogService } from "../src/services/WarEventLogService";
import { WarMailLifecycleService } from "../src/services/WarMailLifecycleService";

const channelSendMock = vi.fn();
const channelFetchMock = vi.fn();

const currentWarUpsertMock = vi.fn();
const trackedClanUpdateMock = vi.fn();
const trackedClanFindUniqueMock = vi.fn();

function buildBlockedRendered(reason: string) {
  return {
    activeWarIdentityResolution: {
      status: "blocked" as const,
      warId: null,
      reason,
    },
    mailChannelId: "mail-channel-1",
    clanRoleId: "555555555555555555",
    warId: 1001,
    opponentTag: "OPP123",
    warStartMs: Date.parse("2026-03-12T00:00:00.000Z"),
    freezeRefresh: false,
    unavailableReasons: [],
    matchType: "FWA" as const,
    expectedOutcome: "WIN" as const,
    mailRevisionDecision: {
      mailStatus: {
        status: "not_posted",
        mailStatusEmoji: ":envelope:",
        debug: {
          currentWarId: "1001",
          trackedMailWarId: null,
          trackedChannelId: null,
          trackedMessageId: null,
          trackedMessageExists: "unknown",
          currentWarConfigMatchesTrackedMessage: false,
          winningSource: "none",
          finalNormalizedStatus: "not_posted",
          reconciliationOutcome: "not_checked",
          reconciliationCertainty: "not_checked",
          debugReasonCode: "no_post_tracked",
          debugReason: "No POSTED lifecycle row exists for the active war.",
          environmentMismatchSignal: false,
          trackingCleared: false,
        },
      },
      liveRevisionFields: null,
      confirmedRevisionBaseline: null,
      effectiveRevisionFields: null,
      appliedDraftRevision: null,
      draftDiffersFromBaseline: false,
      mailBlockedReason: null,
    },
  } as any;
}

function buildResolvedRendered() {
  return {
    activeWarIdentityResolution: {
      status: "resolved" as const,
      warId: 1001,
      source: "existing_exact_row" as const,
      liveValidated: true,
    },
    mailChannelId: "mail-channel-1",
    clanRoleId: "555555555555555555",
    warId: 1001,
    opponentTag: "OPP123",
    warStartMs: Date.parse("2026-03-12T00:00:00.000Z"),
    freezeRefresh: false,
    unavailableReasons: [],
    matchType: "FWA" as const,
    expectedOutcome: "WIN" as const,
    planText: "Plan text",
    embed: { toJSON: () => ({}) },
    inferredMatchType: false,
    mailRevisionDecision: {
      mailStatus: {
        status: "not_posted",
        mailStatusEmoji: ":envelope:",
        debug: {
          currentWarId: "1001",
          trackedMailWarId: null,
          trackedChannelId: null,
          trackedMessageId: null,
          trackedMessageExists: "unknown",
          currentWarConfigMatchesTrackedMessage: false,
          winningSource: "none",
          finalNormalizedStatus: "not_posted",
          reconciliationOutcome: "not_checked",
          reconciliationCertainty: "not_checked",
          debugReasonCode: "no_post_tracked",
          debugReason: "No POSTED lifecycle row exists for the active war.",
          environmentMismatchSignal: false,
          trackingCleared: false,
        },
      },
      liveRevisionFields: null,
      confirmedRevisionBaseline: null,
      effectiveRevisionFields: null,
      appliedDraftRevision: null,
      draftDiffersFromBaseline: false,
      mailBlockedReason: null,
    },
  } as any;
}

function buildInteraction(customId: string) {
  const send = channelSendMock.mockResolvedValue({ id: "sent-message-1" });
  const fetch = channelFetchMock.mockResolvedValue({
    id: "mail-channel-1",
    isTextBased: () => true,
    send,
    messages: { fetch: vi.fn() },
  });
    return {
      customId,
      guildId: "guild-1",
      channelId: "command-channel-1",
      user: { id: "user-1" },
    memberPermissions: {
      has: vi.fn(() => true),
    },
    inGuild: vi.fn(() => true),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    message: { embeds: [] },
    client: {
      channels: {
        fetch,
      },
    },
  } as any;
}

function seedPreviewPayload(key: string) {
  setFwaMailPreviewPayloadForTest(key, {
    userId: "user-1",
    guildId: "guild-1",
    tag: "AAA111",
    revisionOverride: null,
  });
}

describe("FWA mail confirmation handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWarUpsertMock.mockReset();
    trackedClanUpdateMock.mockReset();
    trackedClanFindUniqueMock.mockReset();
    channelSendMock.mockReset();
    channelFetchMock.mockReset();
    prismaMock.currentWar.upsert = currentWarUpsertMock as any;
    prismaMock.trackedClan.update = trackedClanUpdateMock as any;
    prismaMock.trackedClan.findUnique = trackedClanFindUniqueMock as any;
    trackedClanFindUniqueMock.mockResolvedValue({ mailConfig: null });
    trackedClanUpdateMock.mockResolvedValue({});
    currentWarUpsertMock.mockResolvedValue({});
    channelSendMock.mockResolvedValue({ id: "sent-message-1" });
    channelFetchMock.mockResolvedValue({
      id: "mail-channel-1",
      isTextBased: () => true,
      send: channelSendMock,
      messages: { fetch: vi.fn() },
    });
    vi.spyOn(WarMailLifecycleService.prototype, "getLifecycleForWar").mockResolvedValue(
      null as never,
    );
    vi.spyOn(WarMailLifecycleService.prototype, "markPosted").mockResolvedValue(
      undefined,
    );
    vi.spyOn(PointsSyncService.prototype, "getCurrentSyncForClan").mockResolvedValue(
      null as never,
    );
    vi.spyOn(PointsSyncService.prototype, "markConfirmedByClanMail").mockResolvedValue(
      undefined,
    );
    vi.spyOn(RepWorkActivityService.prototype, "recordMailSent").mockResolvedValue(
      true,
    );
    vi.spyOn(WarEventLogService.prototype, "refreshCurrentNotifyPost").mockResolvedValue(
      false as never,
    );
    setFwaMailConfirmRerenderForTest(async () => buildResolvedRendered());
    clearFwaMailPreviewPayloadsForTest();
  });

  afterEach(() => {
    resetFwaMailConfirmRerenderForTest();
    clearFwaMailPreviewPayloadsForTest();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "Confirm and Send",
      buildCustomId: buildFwaMailConfirmCustomId,
      pingRole: true,
    },
    {
      label: "Confirm Without Ping",
      buildCustomId: buildFwaMailConfirmNoPingCustomId,
      pingRole: false,
    },
  ])(
    "rejects $label when the send-time rerender is blocked by partial_live_identity",
    async ({ buildCustomId, pingRole }) => {
      const key = "preview-key-blocked";
      seedPreviewPayload(key);
      setFwaMailConfirmRerenderForTest(async () =>
        buildBlockedRendered("partial_live_identity"),
      );
      const interaction = buildInteraction(buildCustomId("user-1", key));

      await (pingRole ? handleFwaMailConfirmButton : handleFwaMailConfirmNoPingButton)(
        interaction,
      );

      expect(channelFetchMock).not.toHaveBeenCalled();
      expect(channelSendMock).not.toHaveBeenCalled();
      expect(currentWarUpsertMock).not.toHaveBeenCalled();
      expect(trackedClanUpdateMock).not.toHaveBeenCalled();
      expect(WarMailLifecycleService.prototype.markPosted).not.toHaveBeenCalled();
      expect(PointsSyncService.prototype.markConfirmedByClanMail).not.toHaveBeenCalled();
      expect(RepWorkActivityService.prototype.recordMailSent).not.toHaveBeenCalled();
      expect(WarEventLogService.prototype.refreshCurrentNotifyPost).not.toHaveBeenCalled();
      expect(getFwaMailPreviewPayloadForTest(key)).not.toBeNull();
      expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
        "Clash of Clans has not returned the complete active-war identity",
      );
    },
  );

  it.each([
    {
      label: "Confirm and Send",
      buildCustomId: buildFwaMailConfirmCustomId,
      pingRole: true,
      expectedMention: true,
    },
    {
      label: "Confirm Without Ping",
      buildCustomId: buildFwaMailConfirmNoPingCustomId,
      pingRole: false,
      expectedMention: false,
    },
  ])(
    "sends with the latest resolved identity for $label even if the preview payload came from a blocked state",
    async ({ buildCustomId, pingRole, expectedMention }) => {
      const key = "preview-key-resolved";
      seedPreviewPayload(key);
      setFwaMailConfirmRerenderForTest(async () => buildResolvedRendered());
      const interaction = buildInteraction(buildCustomId("user-1", key));

      await (pingRole ? handleFwaMailConfirmButton : handleFwaMailConfirmNoPingButton)(
        interaction,
      );

      expect(channelFetchMock).toHaveBeenCalledTimes(1);
      expect(channelSendMock).toHaveBeenCalledTimes(1);
      const sentPayload = channelSendMock.mock.calls[0]?.[0];
      expect(sentPayload).toEqual(
        expect.objectContaining({
          content: expect.any(String),
          embeds: [expect.any(Object)],
        }),
      );
      expect(Boolean(sentPayload.allowedMentions?.roles?.length)).toBe(expectedMention);
      expect(currentWarUpsertMock).toHaveBeenCalledTimes(1);
      expect(trackedClanUpdateMock).toHaveBeenCalledTimes(1);
      expect(WarMailLifecycleService.prototype.markPosted).toHaveBeenCalledTimes(1);
      expect(PointsSyncService.prototype.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
      expect(RepWorkActivityService.prototype.recordMailSent).toHaveBeenCalledTimes(1);
      expect(WarEventLogService.prototype.refreshCurrentNotifyPost).toHaveBeenCalledTimes(1);
      expect(getFwaMailPreviewPayloadForTest(key)).toBeNull();
    },
  );
});
