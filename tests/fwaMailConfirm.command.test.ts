import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import {
  buildFwaMailConfirmCustomId,
  buildFwaMailConfirmNoPingCustomId,
} from "../src/commands/fwa/customIds";
import {
  handleFwaMailConfirmButton,
  handleFwaMailConfirmNoPingButton,
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
  getLifecycleForWar: vi.fn(),
  markPosted: vi.fn(),
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
    },
  } as any;
}

function buildCurrentWarRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    warId: 1000110,
    state: "preparation",
    startTime: new Date("2026-07-12T15:22:26.000Z"),
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

async function seedConfirmPayloadAndRenderer(input?: {
  previewKey?: string;
  rendered?: ReturnType<typeof buildRenderedMail>;
  currentWarRow?: ReturnType<typeof buildCurrentWarRow>;
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
  return previewKey;
}

describe("fwa mail confirm button", () => {
  let refreshNotifySpy: ReturnType<typeof vi.spyOn>;
  let pollSpy: ReturnType<typeof vi.spyOn>;
  let refreshBattleDayPostsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(lifecycleMock.markPosted).not.toHaveBeenCalled();
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
      expect(lifecycleMock.markPosted).not.toHaveBeenCalled();
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

  it("cancels when the active war changes after send but before the guarded update", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });
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

    expect(send).toHaveBeenCalledTimes(1);
    expect(sentMessage.delete).toHaveBeenCalledTimes(1);
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.markPosted).not.toHaveBeenCalled();
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "The active war changed while mail was being sent, so the mail was cancelled. Please run /fwa match again.",
      embeds: [],
      components: [],
    });
  });

  it("logs guarded-update failures and cancels cleanly", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockRejectedValueOnce(new Error("db boom"));
    const sentMessage = {
      id: "sent-guard-fail",
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn().mockResolvedValue(sentMessage);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=war_mail_guard_update_failed guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC channel_id=mail-channel-1 message_id=sent-guard-fail",
      ),
    );
    expect(sentMessage.delete).toHaveBeenCalledTimes(1);
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(pointsSyncMock.getCurrentSyncForClan).not.toHaveBeenCalled();
    expect(lifecycleMock.markPosted).not.toHaveBeenCalled();
    expect(repWorkActivityMock.recordMailSent).not.toHaveBeenCalled();
    expect(pointsSyncMock.markConfirmedByClanMail).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).not.toHaveBeenCalled();
    expect(globalThis.setInterval).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "The active war changed while mail was being sent, so the mail was cancelled. Please run /fwa match again.",
      embeds: [],
      components: [],
    });
  });

  it("logs compensation failures when deleting a stale send fails", async () => {
    const previewKey = await seedConfirmPayloadAndRenderer();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });
    const sentMessage = {
      id: "sent-1",
      delete: vi.fn().mockRejectedValue(new Error("unknown message")),
    };
    const send = vi.fn().mockResolvedValue(sentMessage);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = createInteraction({
      customId: buildFwaMailConfirmCustomId("owner-1", previewKey),
      send,
    });

    await handleFwaMailConfirmButton(interaction as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[fwa-mail] event=war_mail_compensation_failed guild=guild-1 clan=#R80L8VYG war_id=1000110 war_start=2026-07-12T15:22:26.000Z opponent=#2LYPLQQUC channel_id=mail-channel-1 message_id=sent-1",
      ),
    );
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content:
        "The active war changed while mail was being sent, so the mail was cancelled. Please run /fwa match again.",
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
    lifecycleMock.markPosted.mockResolvedValueOnce(undefined);
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
    expect(lifecycleMock.markPosted).toHaveBeenCalledTimes(1);
    expect(repWorkActivityMock.recordMailSent).toHaveBeenCalledTimes(1);
    expect(pointsSyncMock.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshBattleDayPostsSpy).not.toHaveBeenCalled();
    expect(refreshNotifySpy).toHaveBeenCalledTimes(1);
    expect(globalThis.setInterval).toHaveBeenCalledTimes(1);
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
    lifecycleMock.markPosted.mockResolvedValueOnce(undefined);
    repWorkActivityMock.recordMailSent.mockResolvedValueOnce(undefined);
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
    expect(prisma.currentWar.updateMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        clanTag: "#R80L8VYG",
        warId: 1000110,
        startTime: new Date("2026-07-12T15:22:26.000Z"),
        opponentTag: "#2LYPLQQUC",
        state: {
          in: ["preparation", "inWar"],
        },
      },
      data: {
        channelId: "mail-channel-1",
        matchType: "FWA",
        inferredMatchType: false,
        outcome: "WIN",
        updatedAt: expect.any(Date),
      },
    });
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(lifecycleMock.markPosted).toHaveBeenCalledTimes(1);
    expect(repWorkActivityMock.recordMailSent).toHaveBeenCalledTimes(1);
    expect(pointsSyncMock.markConfirmedByClanMail).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
    expect(refreshNotifySpy).toHaveBeenCalledTimes(1);
    expect(globalThis.setInterval).toHaveBeenCalledTimes(1);
    expect(sentMessage.delete).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
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
    lifecycleMock.markPosted.mockResolvedValueOnce(undefined);
    repWorkActivityMock.recordMailSent.mockResolvedValueOnce(undefined);
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
    expect(prisma.currentWar.update).not.toHaveBeenCalled();
    expect(prisma.currentWar.upsert).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    const followUpContent = String(
      (interaction.followUp.mock.calls[0]?.[0] as { content?: string } | undefined)
        ?.content ?? "",
    );
    expect(followUpContent).toContain("without ping");
  });
});
