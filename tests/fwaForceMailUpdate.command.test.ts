import { afterEach, describe, expect, it, vi } from "vitest";
import { runForceMailUpdateCommand } from "../src/commands/Fwa";
import { prisma } from "../src/prisma";
import {
  WarMailLifecycleService,
  type ResolveWarMailLifecycleStatusResult,
} from "../src/services/WarMailLifecycleService";

function buildLifecycleResult(
  input: Partial<ResolveWarMailLifecycleStatusResult> = {},
): ResolveWarMailLifecycleStatusResult {
  const debug =
    input.debug ??
    ({
      currentWarId: "1000110",
      trackedMailWarId: "1000110",
      trackedChannelId: "mail-channel-1",
      trackedMessageId: "mail-message-1",
      trackedMessageExists: "no",
      currentWarConfigMatchesTrackedMessage: true,
      winningSource: "WarMailLifecycle",
      finalNormalizedStatus: "deleted",
      reconciliationOutcome: "message_missing_confirmed",
      reconciliationCertainty: "definitive",
      debugReasonCode: "tracked_post_missing_message",
      debugReason: "Tracked lifecycle message is definitively missing/deleted; lifecycle was marked DELETED.",
      environmentMismatchSignal: false,
      trackingCleared: true,
    } as const);
  return {
    status: input.status ?? "deleted",
    mailStatusEmoji: input.mailStatusEmoji ?? "U",
    debug,
  };
}

function createInteraction(input?: { tag?: string; guildId?: string; client?: any }) {
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    guildId: input?.guildId ?? "guild-1",
    channelId: "command-channel-1",
    client: input?.client ?? {},
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    options: {
      getString: vi.fn((name: string) => {
        if (name === "visibility") return null;
        if (name === "tag") return input?.tag ?? "R80L8VYG";
        return null;
      }),
    },
  } as any;
}

describe("runForceMailUpdateCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns lifecycle-corrected response when tracked active-war reference is definitively missing", async () => {
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValueOnce({
      tag: "#R80L8VYG",
      name: "DARK EMPIRE",
    } as never);
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValueOnce({
      warId: 1000110,
      startTime: new Date("2026-03-25T04:22:17.000Z"),
    } as never);
    const resolveStatusSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "resolveStatusForCurrentWar")
      .mockResolvedValueOnce(buildLifecycleResult());
    const interaction = createInteraction();

    await runForceMailUpdateCommand(interaction);

    const reply = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    expect(reply).toContain(
      "Tracked mail reference for #R80L8VYG is missing, inaccessible, or otherwise unusable.",
    );
    expect(reply).toContain("WarMailLifecycle -> DELETED");
    expect(reply).toContain("`/force sync mail`");
    expect(resolveStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "R80L8VYG",
        warId: 1000110,
        warStartTime: new Date("2026-03-25T04:22:17.000Z"),
        opponentTag: null,
      }),
    );
  });

  it("keeps existing no-reference behavior when lifecycle is not posted", async () => {
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValueOnce({
      tag: "#R80L8VYG",
      name: "DARK EMPIRE",
    } as never);
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValueOnce({
      warId: 1000110,
      startTime: new Date("2026-03-25T04:22:17.000Z"),
    } as never);
    vi.spyOn(WarMailLifecycleService.prototype, "resolveStatusForCurrentWar").mockResolvedValueOnce(
      buildLifecycleResult({
        status: "not_posted",
        debug: {
          ...buildLifecycleResult().debug,
          trackedChannelId: null,
          trackedMessageId: null,
          trackedMessageExists: "unknown",
          finalNormalizedStatus: "not_posted",
          reconciliationOutcome: "not_checked",
          reconciliationCertainty: "not_checked",
          debugReasonCode: "no_post_tracked",
          debugReason: "No POSTED lifecycle row exists for the active war.",
          trackingCleared: false,
        },
      }),
    );
    const interaction = createInteraction();

    await runForceMailUpdateCommand(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "No active sent mail reference found for #R80L8VYG. Send mail first or sync it via `/force sync mail`.",
    );
  });

  it("returns lifecycle-corrected response when tracked channel is inaccessible for active-war mail", async () => {
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValueOnce({
      tag: "#R80L8VYG",
      name: "DARK EMPIRE",
    } as never);
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValueOnce({
      warId: 1000110,
      startTime: new Date("2026-03-25T04:22:17.000Z"),
    } as never);
    vi.spyOn(WarMailLifecycleService.prototype, "resolveStatusForCurrentWar").mockResolvedValueOnce(
      buildLifecycleResult({
        status: "deleted",
        debug: {
          ...buildLifecycleResult().debug,
          reconciliationOutcome: "channel_inaccessible",
          debugReasonCode: "tracked_post_inaccessible_channel",
        },
      }),
    );
    const interaction = createInteraction();

    await runForceMailUpdateCommand(interaction);

    const reply = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    expect(reply).toContain("Tracked mail reference for #R80L8VYG is missing, inaccessible, or otherwise unusable.");
    expect(reply).toContain("WarMailLifecycle -> DELETED");
  });

  it("guards lifecycle deletion by tracked message identity when refresh target is missing", async () => {
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValueOnce({
      tag: "#R80L8VYG",
      name: "DARK EMPIRE",
    } as never);
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValueOnce({
      warId: 1000110,
      startTime: new Date("2026-03-25T04:22:17.000Z"),
    } as never);
    vi.spyOn(WarMailLifecycleService.prototype, "resolveStatusForCurrentWar").mockResolvedValueOnce(
      buildLifecycleResult({
        status: "posted",
        debug: {
          ...buildLifecycleResult().debug,
          trackedMessageExists: "yes",
          finalNormalizedStatus: "posted",
          reconciliationOutcome: "exists",
          reconciliationCertainty: "definitive",
          debugReasonCode: "live_matching_post_exists",
          debugReason: "Tracked lifecycle message exists for the active war.",
          trackingCleared: false,
        },
      }),
    );
    const guardedDeleteSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "markDeletedIfTrackedMessageMatches")
      .mockResolvedValueOnce("stale_target");
    const interaction = createInteraction({
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            isTextBased: () => true,
            messages: {
              fetch: vi.fn().mockRejectedValue({ code: 10008, message: "Unknown Message" }),
            },
          }),
        },
      },
    });

    await runForceMailUpdateCommand(interaction);

    expect(guardedDeleteSpy).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "R80L8VYG",
      warId: 1000110,
      warStartTime: new Date("2026-03-25T04:22:17.000Z"),
      channelId: "mail-channel-1",
      messageId: "mail-message-1",
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Could not refresh #R80L8VYG mail in place. The stored message was missing or inaccessible.",
    );
  });
});

