import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import {
  buildFwaMailConfirmCustomId,
  buildFwaMailConfirmNoPingCustomId,
} from "../src/commands/fwa/customIds";
import {
  handleFwaMailConfirmButton,
  handleFwaMailConfirmNoPingButton,
  buildFwaMailSendClaimKeyForTest,
  setFwaMailConfirmRendererForTest,
  setFwaMailPreviewPayloadForTest,
} from "../src/commands/Fwa";
import { prisma } from "../src/prisma";
import { WarEventLogService } from "../src/services/WarEventLogService";

const prismaMock = vi.hoisted(() => ({
  currentWar: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  trackedClan: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

const pointsSyncMock = vi.hoisted(() => ({
  getCurrentSyncForClan: vi.fn(),
  markConfirmedByClanMail: vi.fn(),
}));

vi.mock("../src/services/PointsSyncService", () => ({
  PointsSyncService: vi.fn().mockImplementation(() => pointsSyncMock),
}));

const lifecycleMock = vi.hoisted(() => ({
  acquireSendClaim: vi.fn(),
  finalizeSendClaim: vi.fn(),
  releaseSendClaim: vi.fn(),
  getLifecycleForWar: vi.fn(),
}));

vi.mock("../src/services/WarMailLifecycleService", () => ({
  WarMailLifecycleService: vi
    .fn()
    .mockImplementation(() => lifecycleMock),
}));

const repWorkActivityMock = vi.hoisted(() => ({
  recordMailSent: vi.fn(),
}));

vi.mock("../src/services/RepWorkActivityService", () => ({
  repWorkActivityService: repWorkActivityMock,
}));

const cocServiceMock = vi.hoisted(() => ({
  getCurrentWar: vi.fn(),
}));

vi.mock("../src/services/CoCService", () => ({
  CoCService: vi.fn().mockImplementation(() => cocServiceMock),
}));

function buildRenderedMail(overrides?: Partial<{
  mailChannelId: string | null;
  clanRoleId: string | null;
  warId: number | null;
  opponentTag: string | null;
  warStartMs: number | null;
  freezeRefresh: boolean;
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  unavailableReasons: string[];
  planText: string;
  mailBlockedReason: string | null;
}>) {
  return {
    embed: new EmbedBuilder().setTitle("Mail preview"),
    planText: overrides?.planText ?? "Plan body",
    inferredMatchType: false,
    mailChannelId: overrides?.mailChannelId ?? "mail-channel-1",
    clanRoleId: overrides?.clanRoleId ?? "123456789",
    warId: overrides?.warId ?? 1000110,
    opponentTag: overrides?.opponentTag ?? "2LYPLQQUC",
    warStartMs:
      overrides?.warStartMs ?? new Date("2026-07-12T15:22:26.000Z").getTime(),
    freezeRefresh: overrides?.freezeRefresh ?? false,
    unavailableReasons: overrides?.unavailableReasons ?? [],
    matchType: overrides?.matchType ?? "FWA",
    expectedOutcome: overrides?.expectedOutcome ?? "WIN",
    mailRevisionDecision: {
      mailBlockedReason: overrides?.mailBlockedReason ?? null,
      effectiveRevisionFields: {
        warId: String(overrides?.warId ?? 1000110),
        opponentTag: overrides?.opponentTag ?? "2LYPLQQUC",
        matchType: overrides?.matchType ?? "FWA",
        expectedOutcome:
          (overrides?.matchType ?? "FWA") === "FWA"
            ? overrides?.expectedOutcome ?? "WIN"
            : null,
      },
    },
  } as any;
}

function buildCurrentWarRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    warId: 1000110,
    state: "preparation",
    startTime: new Date("2026-07-12T15:22:26.000Z"),
    updatedAt: new Date("2026-07-12T15:24:26.000Z"),
    opponentTag: "#2LYPLQQUC",
    matchType: "FWA",
    inferredMatchType: false,
    outcome: "WIN",
    fwaPoints: null,
    opponentFwaPoints: null,
    endTime: null,
    opponentName: "Opponent",
    clanStars: null,
    opponentStars: null,
    ...overrides,
  } as any;
}

function createInteraction(params: {
  customId: string;
  send: ReturnType<typeof vi.fn>;
}) {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const deleteReply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  return {
    customId: params.customId,
    user: { id: "owner-1" },
    guildId: "guild-1",
    channelId: "command-channel-1",
    inGuild: () => true,
    memberPermissions: {
      has: () => true,
    },
    message: { embeds: [] },
    client: {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          id: "mail-channel-1",
          isTextBased: () => true,
          send: params.send,
          messages: { fetch: vi.fn() },
        }),
      },
    },
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply,
    reply,
    deleteReply,
    followUp,
  } as any;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function seedConfirmPayloadAndRenderer(input?: {
  previewKey?: string;
  rendered?: ReturnType<typeof buildRenderedMail>;
  currentWarRow?: ReturnType<typeof buildCurrentWarRow>;
  retryCurrentWarRow?: ReturnType<typeof buildCurrentWarRow>;
}) {
  const previewKey = input?.previewKey ?? "preview-key";
  setFwaMailPreviewPayloadForTest(previewKey, {
    userId: "owner-1",
    guildId: "guild-1",
    tag: "R80L8VYG",
    revisionOverride: null,
  });
  setFwaMailConfirmRendererForTest(async () => input?.rendered ?? buildRenderedMail());
  prismaMock.currentWar.findUnique.mockResolvedValueOnce(
    input?.currentWarRow ?? buildCurrentWarRow(),
  );
  if (input?.retryCurrentWarRow) {
    prismaMock.currentWar.findUnique.mockResolvedValueOnce(
      input.retryCurrentWarRow,
    );
  }
  return previewKey;
}

describe("fwa mail confirm button", () => {
  let refreshNotifySpy: ReturnType<typeof vi.spyOn>;
  let pollSpy: ReturnType<typeof vi.spyOn>;
  let refreshBattleDayPostsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMock.acquireSendClaim.mockResolvedValue({ result: "acquired" });
    lifecycleMock.finalizeSendClaim.mockResolvedValue(true);
    lifecycleMock.releaseSendClaim.mockResolvedValue(true);
    pollSpy = vi.spyOn(WarEventLogService.prototype, "poll").mockResolvedValue(
      undefined,
    );
    refreshBattleDayPostsSpy = vi
      .spyOn(WarEventLogService.prototype, "refreshBattleDayPosts")
      .mockResolvedValue(undefined);
    refreshNotifySpy = vi
      .spyOn(WarEventLogService.prototype, "refreshCurrentNotifyPost")
      .mockResolvedValue(undefined);
    vi.spyOn(globalThis, "setInterval").mockImplementation((() => 1) as any);
  });

  afterEach(() => {
    setFwaMailConfirmRendererForTest(null);
    setFwaMailPreviewPayloadForTest("preview-key", null);
    setFwaMailPreviewPayloadForTest("preview-no-ping", null);
    pollSpy.mockRestore();
    refreshBattleDayPostsSpy.mockRestore();
    refreshNotifySpy.mockRestore();
    vi.restoreAllMocks();
  });

  it.each([0, -1])(
    "blocks invalid war ID %s before send",
    async (invalidWarId) => {
      const previewKey = await seedConfirmPayloadAndRenderer({
        rendered: buildRenderedMail({ warId: invalidWarId }),
      });
      const send = vi.fn();
      const interaction = createInteraction({
        customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
        send,
      });

      await handleFwaMailConfirmButton(interaction as any);

      expect(send).not.toHaveBeenCalled();
      expect(prisma.currentWar.updateMany).not.toHaveBeenCalled();
      expect(prisma.currentWar.update).not.toHaveBeenCalled();
      expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
      expect(pointsSyncMock.getCurrentSyncForClan).not.toHaveBeenCalled();
      expect(lifecycleMock.acquireSendClaim).not.toHaveBeenCalled();
      expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
      expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
      expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
      expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
      expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
      expect(pollSpy).not.toHaveBeenCalled();
      expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
      expect(refreshNotifySpy).not.toHaveBeenCalled();
      expect(globalThis.setInterval).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenLastCalledWith({
        content:
          "Cannot send mail because the active war changed. Please run /fwa match again.",
        embeds: [],
        components: [],
      });
    },
  );

  it("fails closed when the active war changes before send", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer({
      currentWarRow: buildCurrentWarRow({
        warId: 1000999,
        opponentTag: "#2OLDTAG",
      }),
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    const send = vi.fn();
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.updateMany).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(pointsSyncMock.getCurrentSyncForClan).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "Cannot send mail because the active war changed. Please run /fwa match again.",
      embeds: [],
      components: [],
    });
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledWith({
      where: {
        clanTag_guildId: {
          guildId: "guild-1",
          clanTag: "#R80L8VYG",
        },
      },
      select: expect.objectContaining({
        state: true,
        warId: true,
        startTime: true,
        opponentTag: true,
      }),
    });
  });

  it("retries once when the same physical war still exists after a guarded update miss", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer({
      currentWarRow: buildCurrentWarRow({
        opponentTag: "2LYPLQQUC",
        updatedAt: new Date("2026-07-12T15:24:26.000Z"),
      }),
      retryCurrentWarRow: buildCurrentWarRow({
        opponentTag: "2LYPLQQUC",
        updatedAt: new Date("2026-07-12T15:24:27.000Z"),
      }),
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      mailConfig: null,
    });
    prismaMock.trackedClan.update.mockResolvedValueOnce({});
    pointsSyncMock.getCurrentSyncForClan.mockResolvedValueOnce(null);
    pointsSyncMock.markConfirmedByClanMail.mockResolvedValueOnce(undefined);
    lifecycleMock.getLifecycleForWar.mockResolvedValueOnce(null);
    repWorkActivityMock.recordMailSent.mockResolvedValueOnce(undefined);
    const sentMessage = {
      id: "sent-retry",
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(sentMessage);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(send).toHaveBeenCalledTimes(1);
    expect(prisma.currentWar.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(repWorkActivityMock.recordMailSent).toHaveBeenCalledTimes(1);
    expect(pointsSyncMock.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).toHaveBeenCalledTimes(1);
    expect(globalThis.setInterval).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=pre_send_guard guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC stored_opponent_tag_form=bare result=retry_owned reason=revision_changed initial_update_count=0 retry_update_count=1 interaction_channel_id=command-channel-1 interaction_user_id=owner-1",
      ),
    );
  });

  it("skips sending when the reread points to a different physical war", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer({
      currentWarRow: buildCurrentWarRow({
        opponentTag: "2LYPLQQUC",
        updatedAt: new Date("2026-07-12T15:24:26.000Z"),
      }),
      retryCurrentWarRow: buildCurrentWarRow({
        warId: 1000999,
        startTime: new Date("2026-07-12T16:22:26.000Z"),
        opponentTag: "#2OLDTAG",
        updatedAt: new Date("2026-07-12T15:24:27.000Z"),
      }),
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });
    const send = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(send).not.toHaveBeenCalled();
    expect(prisma.currentWar.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.releaseSendClaim).toHaveBeenCalledTimes(1);
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=pre_send_guard guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC stored_opponent_tag_form=canonical result=stale reason=identity_changed initial_update_count=0 interaction_channel_id=command-channel-1 interaction_user_id=owner-1",
      ),
    );
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "Cannot send mail because the active war changed. Please run /fwa match again.",
      embeds: [],
      components: [],
    });
  });

  it("logs guarded-update failures and cancels cleanly", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockRejectedValueOnce(new Error("db boom"));
    const send = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=pre_send_guard guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC stored_opponent_tag_form=canonical result=failed reason=db_error initial_update_count=0 interaction_channel_id=command-channel-1 interaction_user_id=owner-1 error=db boom",
      ),
    );
    expect(send).not.toHaveBeenCalled();
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.releaseSendClaim).toHaveBeenCalledTimes(1);
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "Cannot send mail because the active war changed. Please run /fwa match again.",
      embeds: [],
      components: [],
    });
  });

  it("fails closed when the send claim cannot be acquired", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    lifecycleMock.acquireSendClaim.mockRejectedValueOnce(new Error("acquire boom"));
    const send = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=mail_send_claim guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC result=failed reason=acquire_error error=acquire boom",
      ),
    );
    expect(send).not.toHaveBeenCalled();
    expect(prisma.currentWar.updateMany).not.toHaveBeenCalled();
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content: "Failed to reserve war mail send. Please try again.",
      embeds: [],
      components: [],
    });
  });

  it("logs discord send failures after a successful guard and keeps retry available", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    const send = vi.fn().mockRejectedValueOnce(new Error("send boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(prisma.currentWar.updateMany).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      prisma.currentWar.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=discord_send_failed guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC mail_channel_id=mail-channel-1 interaction_channel_id=command-channel-1 interaction_user_id=owner-1 result=failed error=send boom",
      ),
    );
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.releaseSendClaim).toHaveBeenCalledTimes(1);
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();
    expect(
      lifecycleMock.releaseSendClaim.mock.invocationCallOrder[0],
    ).toBeGreaterThan(send.mock.invocationCallOrder[0]);
    const failureReply = interaction.editReply.mock.calls[
      interaction.editReply.mock.calls.length - 1
    ]?.[0] as
      | { content?: string; components?: unknown[] }
      | undefined;
    expect(failureReply).toMatchObject({
      content: "Failed to send war mail.",
      embeds: [],
    });
    expect(failureReply?.components).toEqual(expect.any(Array));
    expect(failureReply?.components?.length).toBeGreaterThan(0);
  });

  it("fails closed when lifecycle finalization fails after the message is sent", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    lifecycleMock.finalizeSendClaim.mockResolvedValueOnce(false);
    const send = vi.fn().mockResolvedValue({
      id: "sent-finalize-failed",
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(send).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(
      prisma.currentWar.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(
      send.mock.invocationCallOrder[0],
    ).toBeLessThan(lifecycleMock.finalizeSendClaim.mock.invocationCallOrder[0]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=send_claim_finalize_failed_after_send guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC mail_channel_id=mail-channel-1 message_id=sent-finalize-failed interaction_channel_id=command-channel-1 interaction_user_id=owner-1 result=orphaned_public_message",
      ),
    );
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();
    const failureReply = interaction.editReply.mock.calls[
      interaction.editReply.mock.calls.length - 1
    ]?.[0] as
      | { content?: string; components?: unknown[] }
      | undefined;
    expect(failureReply).toMatchObject({
      content:
        "War mail was posted, but tracking could not be finalized. Please contact an administrator.",
      embeds: [],
    });
    expect(failureReply?.components).toEqual([]);
  });

  it("keeps the command safe when releasing a claim fails after send throws", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    lifecycleMock.releaseSendClaim.mockRejectedValueOnce(new Error("release boom"));
    const send = vi.fn().mockRejectedValueOnce(new Error("send boom"));
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(send).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).not.toHaveBeenCalled();
    expect(lifecycleMock.releaseSendClaim).toHaveBeenCalledTimes(1);
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(
      prisma.currentWar.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "Failed to send war mail, and the send lock could not be released. Please contact an administrator.",
      embeds: [],
      components: [],
    });
  });

  it("prevents two concurrent confirmations from producing two public posts", async () => {
    const previewKey = "preview-concurrent";
    setFwaMailPreviewPayloadForTest(previewKey, {
      userId: "owner-1",
      guildId: "guild-1",
      tag: "R80L8VYG",
      revisionOverride: null,
    });
    setFwaMailConfirmRendererForTest(async () => buildRenderedMail());
    const currentWarState = buildCurrentWarRow();
    const rereadUpdatedAts: string[] = [];
    prismaMock.currentWar.findUnique.mockImplementation(async () => {
      rereadUpdatedAts.push(currentWarState.updatedAt.toISOString());
      return {
        ...currentWarState,
        updatedAt: new Date(currentWarState.updatedAt.getTime()),
      };
    });
    prismaMock.currentWar.updateMany.mockImplementation(async ({ data }) => {
      currentWarState.channelId = String(data.channelId ?? "mail-channel-1");
      currentWarState.matchType = String(data.matchType ?? currentWarState.matchType);
      currentWarState.inferredMatchType = Boolean(data.inferredMatchType);
      currentWarState.outcome = data.outcome ?? currentWarState.outcome;
      currentWarState.updatedAt = new Date(
        currentWarState.updatedAt.getTime() + 1000,
      );
      return { count: 1 };
    });
    const sentMessage = {
      id: "sent-concurrent",
      delete: vi.fn().mockResolvedValue(undefined),
      edit: vi.fn().mockResolvedValue(undefined),
      embeds: [],
    };
    const sendStarted = createDeferred<void>();
    const sendRelease = createDeferred<typeof sentMessage>();
    const send = vi.fn().mockImplementation(() => {
      sendStarted.resolve();
      return sendRelease.promise;
    });
    const oldMessageEdit = vi.fn().mockResolvedValue(undefined);
    const oldChannel = {
      id: "old-channel",
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue({
          id: "old-message",
          edit: oldMessageEdit,
          embeds: [],
        }),
      },
    };
    const mailChannel = {
      id: "mail-channel-1",
      isTextBased: () => true,
      send,
      messages: { fetch: vi.fn() },
    };
    prismaMock.trackedClan.findUnique.mockResolvedValue({ mailConfig: null });
    prismaMock.trackedClan.update.mockResolvedValue({});
    pointsSyncMock.getCurrentSyncForClan.mockResolvedValue(null);
    pointsSyncMock.markConfirmedByClanMail.mockResolvedValue(undefined);
    lifecycleMock.getLifecycleForWar.mockResolvedValue({
      status: "POSTED",
      channelId: "old-channel",
      messageId: "old-message",
    });
    let claimAcquired = false;
    lifecycleMock.acquireSendClaim.mockImplementation(async () => {
      if (claimAcquired) {
        return { result: "already_in_flight" as const };
      }
      claimAcquired = true;
      return { result: "acquired" as const };
    });
    repWorkActivityMock.recordMailSent.mockResolvedValue(undefined);
    const interactionOne = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });
    const interactionTwo = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });
    interactionOne.client.channels.fetch = vi
      .fn()
      .mockImplementation(async (channelId: string) =>
        channelId === "old-channel" ? oldChannel : mailChannel,
      );
    interactionTwo.client.channels.fetch = vi
      .fn()
      .mockImplementation(async (channelId: string) =>
        channelId === "old-channel" ? oldChannel : mailChannel,
      );

    const firstRun = handleFwaMailConfirmButton(interactionOne as any);
    await sendStarted.promise;
    const secondRun = handleFwaMailConfirmButton(interactionTwo as any);
    sendRelease.resolve(sentMessage);
    await Promise.all([firstRun, secondRun]);

    expect(rereadUpdatedAts).toEqual([
      "2026-07-12T15:24:26.000Z",
      "2026-07-12T15:24:27.000Z",
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(prisma.currentWar.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(2);
    expect(lifecycleMock.finalizeSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(repWorkActivityMock.recordMailSent).toHaveBeenCalledTimes(1);
    expect(pointsSyncMock.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
    expect(oldMessageEdit).toHaveBeenCalledTimes(1);
    expect(sentMessage.edit).not.toHaveBeenCalled();
    expect(interactionOne.followUp).toHaveBeenCalledTimes(1);
    expect(interactionTwo.followUp).not.toHaveBeenCalled();
    expect(interactionTwo.editReply).toHaveBeenLastCalledWith({
      content: "War mail is already being sent for this war.",
      embeds: [],
      components: [],
    });
  });

  it("omits matchType from the guarded update when the rendered match is UNKNOWN", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer({
      rendered: buildRenderedMail({
        matchType: "UNKNOWN",
        expectedOutcome: "UNKNOWN",
      }),
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      mailConfig: null,
    });
    prismaMock.trackedClan.update.mockResolvedValueOnce({});
    pointsSyncMock.getCurrentSyncForClan.mockResolvedValueOnce(null);
    pointsSyncMock.markConfirmedByClanMail.mockResolvedValueOnce(undefined);
    lifecycleMock.getLifecycleForWar.mockResolvedValueOnce(null);
    repWorkActivityMock.recordMailSent.mockResolvedValueOnce(undefined);
    const sentMessage = {
      id: "sent-unknown",
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(sentMessage);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    const updateCall = prismaMock.currentWar.updateMany.mock.calls[0]?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(updateCall?.data).toMatchObject({
      channelId: "mail-channel-1",
      inferredMatchType: true,
      outcome: null,
      updatedAt: expect.any(Date),
    });
    expect(updateCall?.data).not.toHaveProperty("matchType");
    expect(sentMessage.delete).not.toHaveBeenCalled();
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(repWorkActivityMock.recordMailSent).toHaveBeenCalledTimes(1);
    expect(pointsSyncMock.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).toHaveBeenCalledTimes(1);
    expect(globalThis.setInterval).toHaveBeenCalledTimes(1);
    const acquireCall = lifecycleMock.acquireSendClaim.mock.calls[0]?.[0] as
      | { sendKey?: string }
      | undefined;
    expect(acquireCall?.sendKey).toBe(
      buildFwaMailSendClaimKeyForTest({
        guildId: "guild-1",
        clanTag: "R80L8VYG",
        warId: 1000110,
        warStartTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "2LYPLQQUC",
        revision: {
          warId: "1000110",
          opponentTag: "2LYPLQQUC",
          matchType: "UNKNOWN",
          expectedOutcome: null,
        },
      }),
    );
  });

  it("sends and records the pinging confirmation on the success path", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer({
      currentWarRow: buildCurrentWarRow(),
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      mailConfig: null,
    });
    prismaMock.trackedClan.update.mockResolvedValueOnce({});
    pointsSyncMock.getCurrentSyncForClan.mockResolvedValueOnce(null);
    pointsSyncMock.markConfirmedByClanMail.mockResolvedValueOnce(undefined);
    lifecycleMock.getLifecycleForWar.mockResolvedValueOnce(null);
    repWorkActivityMock.recordMailSent.mockResolvedValueOnce(undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sentMessage = {
      id: "sent-1",
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(sentMessage);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    const pingSendPayload = send.mock.calls[0]?.[0] as
      | {
          content?: string;
          allowedMentions?: { roles?: string[] } | undefined;
          embeds?: unknown[];
          components?: unknown[];
        }
      | undefined;
    expect(pingSendPayload?.content ?? "").toContain("<@&123456789>");
    expect(pingSendPayload?.allowedMentions).toEqual({ roles: ["123456789"] });
    expect(pingSendPayload?.embeds?.[0]).toEqual(expect.any(EmbedBuilder));
    expect(pingSendPayload?.components).toEqual(expect.any(Array));
    expect(
      prisma.currentWar.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(
      lifecycleMock.acquireSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.currentWar.updateMany.mock.invocationCallOrder[0]);
    expect(prisma.currentWar.updateMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        clanTag: "#R80L8VYG",
        warId: 1000110,
        startTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "#2LYPLQQUC",
        updatedAt: new Date("2026-07-12T15:24:26.000Z"),
        state: {
          in: ["preparation", "inWar"],
        },
      },
      data: {
        channelId: "mail-channel-1",
        matchType: "FWA",
        inferredMatchType: false,
        outcome: "WIN",
        opponentTag: "#2LYPLQQUC",
        updatedAt: expect.any(Date),
      },
    });
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(repWorkActivityMock.recordMailSent).toHaveBeenCalledTimes(1);
    expect(pointsSyncMock.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
    expect(
      lifecycleMock.finalizeSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(repWorkActivityMock.recordMailSent.mock.invocationCallOrder[0]);
    expect(
      lifecycleMock.finalizeSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(pointsSyncMock.markConfirmedByClanMail.mock.invocationCallOrder[0]);
    expect(
      lifecycleMock.finalizeSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prismaMock.trackedClan.update.mock.invocationCallOrder[0]);
    expect(refreshNotifySpy).toHaveBeenCalledTimes(1);
    expect(globalThis.setInterval).toHaveBeenCalledTimes(1);
    expect(sentMessage.delete).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    const acquireCall = lifecycleMock.acquireSendClaim.mock.calls[0]?.[0] as
      | { sendKey?: string }
      | undefined;
    expect(acquireCall?.sendKey).toBe(
      buildFwaMailSendClaimKeyForTest({
        guildId: "guild-1",
        clanTag: "R80L8VYG",
        warId: 1000110,
        warStartTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "2LYPLQQUC",
        revision: {
          warId: "1000110",
          opponentTag: "2LYPLQQUC",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=pre_send_guard_succeeded guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC mail_channel_id=mail-channel-1 interaction_channel_id=command-channel-1 interaction_user_id=owner-1 result=success",
      ),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=mail_posted guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC mail_channel_id=mail-channel-1 message_id=sent-1 interaction_channel_id=command-channel-1 interaction_user_id=owner-1 ping_role=yes result=posted",
      ),
    );
  });

  it("sends without pinging on the no-ping confirmation path", async () => {
    const previewKey = "preview-no-ping";
    setFwaMailPreviewPayloadForTest(previewKey, {
      userId: "owner-1",
      guildId: "guild-1",
      tag: "R80L8VYG",
      revisionOverride: null,
    });
    setFwaMailConfirmRendererForTest(async () => buildRenderedMail());
    prismaMock.currentWar.findUnique.mockResolvedValueOnce(buildCurrentWarRow());
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      mailConfig: null,
    });
    prismaMock.trackedClan.update.mockResolvedValueOnce({});
    pointsSyncMock.getCurrentSyncForClan.mockResolvedValueOnce(null);
    pointsSyncMock.markConfirmedByClanMail.mockResolvedValueOnce(undefined);
    lifecycleMock.getLifecycleForWar.mockResolvedValueOnce(null);
    repWorkActivityMock.recordMailSent.mockResolvedValueOnce(undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sentMessage = {
      id: "sent-2",
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(sentMessage);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmNoPingCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmNoPingButton(interaction as any);

    const noPingPayload = send.mock.calls[0]?.[0] as
      | {
          content?: string;
          allowedMentions?: { roles?: string[] } | undefined;
          embeds?: unknown[];
          components?: unknown[];
        }
      | undefined;
    expect(noPingPayload?.content ?? "").not.toContain("<@&123456789>");
    expect(noPingPayload?.allowedMentions).toBeUndefined();
    expect(noPingPayload?.embeds?.[0]).toEqual(expect.any(EmbedBuilder));
    expect(noPingPayload?.components).toEqual(expect.any(Array));
    expect(
      prisma.currentWar.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(
      send.mock.invocationCallOrder[0],
    ).toBeLessThan(lifecycleMock.finalizeSendClaim.mock.invocationCallOrder[0]);
    expect(prisma.currentWar.updateMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        clanTag: "#R80L8VYG",
        warId: 1000110,
        startTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "#2LYPLQQUC",
        updatedAt: new Date("2026-07-12T15:24:26.000Z"),
        state: {
          in: ["preparation", "inWar"],
        },
      },
      data: {
        channelId: "mail-channel-1",
        matchType: "FWA",
        inferredMatchType: false,
        outcome: "WIN",
        opponentTag: "#2LYPLQQUC",
        updatedAt: expect.any(Date),
      },
    });
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.acquireSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.finalizeSendClaim).toHaveBeenCalledTimes(1);
    expect(lifecycleMock.releaseSendClaim).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    const followUpContent = String(
      (interaction.followUp.mock.calls[0]?.[0] as { content?: string } | undefined)
        ?.content ?? "",
    );
    expect(followUpContent).toContain("without ping");
    expect(
      lifecycleMock.finalizeSendClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(prismaMock.trackedClan.update.mock.invocationCallOrder[0]);
    const noPingAcquireCall = lifecycleMock.acquireSendClaim.mock.calls[0]?.[0] as
      | { sendKey?: string }
      | undefined;
    expect(noPingAcquireCall?.sendKey).toBe(
      buildFwaMailSendClaimKeyForTest({
        guildId: "guild-1",
        clanTag: "R80L8VYG",
        warId: 1000110,
        warStartTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "2LYPLQQUC",
        revision: {
          warId: "1000110",
          opponentTag: "2LYPLQQUC",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=pre_send_guard_succeeded guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC mail_channel_id=mail-channel-1 interaction_channel_id=command-channel-1 interaction_user_id=owner-1 result=success",
      ),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=mail_posted guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC mail_channel_id=mail-channel-1 message_id=sent-2 interaction_channel_id=command-channel-1 interaction_user_id=owner-1 ping_role=no result=posted",
      ),
    );
  });

  it("derives a deterministic send key from the canonical active-war revision", () => {
    const base = buildFwaMailSendClaimKeyForTest({
      guildId: "guild-1",
      clanTag: "R80L8VYG",
      warId: 1000110,
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "2LYPLQQUC",
      revision: {
        warId: "1000110",
        opponentTag: "2LYPLQQUC",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
    });
    const same = buildFwaMailSendClaimKeyForTest({
      guildId: "guild-1",
      clanTag: "R80L8VYG",
      warId: 1000110,
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "2LYPLQQUC",
      revision: {
        warId: "1000110",
        opponentTag: "2LYPLQQUC",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
    });
    const different = buildFwaMailSendClaimKeyForTest({
      guildId: "guild-1",
      clanTag: "R80L8VYG",
      warId: 1000110,
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "2LYPLQQUC",
      revision: {
        warId: "1000110",
        opponentTag: "2LYPLQQUC",
        matchType: "FWA",
        expectedOutcome: "LOSE",
      },
    });

    expect(base).toBe(same);
    expect(base).not.toBe(different);
    expect(base).toMatch(/^wml:[0-9a-f]{64}$/);
  });
});
