import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import {
  WarMailStatusService,
  type WarMailTrackedTarget,
} from "../src/services/WarMailStatusService";

function buildTrackedTarget(overrides?: Partial<WarMailTrackedTarget>): WarMailTrackedTarget {
  return {
    channelId: "123",
    messageId: "456",
    warId: "999",
    warStartMs: 1_700_000_000_000,
    source: "stored_message",
    ...overrides,
  };
}

function buildClient(params: {
  channelResult?: unknown;
  channelError?: unknown;
  messageResult?: unknown;
  messageError?: unknown;
}): Client {
  const fetchMessage = vi.fn();
  if (params.messageError) {
    fetchMessage.mockRejectedValue(params.messageError);
  } else {
    fetchMessage.mockResolvedValue(params.messageResult ?? { id: "456" });
  }

  const channelObject = {
    isTextBased: () => true,
    messages: {
      fetch: fetchMessage,
    },
  };

  const fetchChannel = vi.fn();
  if (params.channelError) {
    fetchChannel.mockRejectedValue(params.channelError);
  } else {
    fetchChannel.mockResolvedValue(params.channelResult ?? channelObject);
  }

  return {
    channels: {
      fetch: fetchChannel,
    },
  } as unknown as Client;
}

describe("WarMailStatusService", () => {
  it("returns live_matching_post_exists when tracked message is present", async () => {
    const service = new WarMailStatusService();
    const result = await service.resolveStatus({
      client: buildClient({}),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget: buildTrackedTarget(),
    });

    expect(result.status).toBe("live_matching_post_exists");
    expect(result.reconciliationOutcome).toBe("exists");
    expect(result.trackingCleared).toBe(false);
  });

  it("returns tracked_post_missing and invokes cleanup when message is confirmed missing", async () => {
    const service = new WarMailStatusService();
    const cleanup = vi.fn().mockResolvedValue(true);
    const result = await service.resolveStatus({
      client: buildClient({
        messageError: { code: 10008, message: "Unknown Message" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget: buildTrackedTarget(),
      onDefinitiveMissing: cleanup,
    });

    expect(result.status).toBe("tracked_post_missing");
    expect(result.reconciliationOutcome).toBe("message_missing_confirmed");
    expect(result.trackingCleared).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns tracked_post_missing and invokes cleanup when channel is confirmed missing", async () => {
    const service = new WarMailStatusService();
    const cleanup = vi.fn().mockResolvedValue(true);
    const result = await service.resolveStatus({
      client: buildClient({
        channelError: { code: 10003, message: "Unknown Channel" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget: buildTrackedTarget(),
      onDefinitiveMissing: cleanup,
    });

    expect(result.status).toBe("tracked_post_missing");
    expect(result.reconciliationOutcome).toBe("channel_missing_confirmed");
    expect(result.trackingCleared).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns tracked_post_mismatch when current live config does not match posted state", async () => {
    const service = new WarMailStatusService();
    const cleanup = vi.fn().mockResolvedValue(true);
    const result = await service.resolveStatus({
      client: buildClient({}),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: false,
      trackedTarget: buildTrackedTarget(),
      onDefinitiveMissing: cleanup,
    });

    expect(result.status).toBe("tracked_post_mismatch");
    expect(result.reconciliationOutcome).toBe("not_checked");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("returns transient_unverified without cleanup for inaccessible channel permissions", async () => {
    const service = new WarMailStatusService();
    const cleanup = vi.fn().mockResolvedValue(true);
    const result = await service.resolveStatus({
      client: buildClient({
        channelError: { code: 50001, message: "Missing Access" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget: buildTrackedTarget(),
      onDefinitiveMissing: cleanup,
    });

    expect(result.status).toBe("transient_unverified");
    expect(result.reconciliationOutcome).toBe("channel_inaccessible");
    expect(result.trackingCleared).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("returns transient_unverified without cleanup for transient message fetch errors", async () => {
    const service = new WarMailStatusService();
    const cleanup = vi.fn().mockResolvedValue(true);
    const result = await service.resolveStatus({
      client: buildClient({
        messageError: { message: "network timeout while fetching message" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget: buildTrackedTarget(),
      onDefinitiveMissing: cleanup,
    });

    expect(result.status).toBe("transient_unverified");
    expect(result.reconciliationOutcome).toBe("transient_error");
    expect(result.trackingCleared).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("returns no_post_tracked after cleanup removes stale target on subsequent evaluation", async () => {
    const service = new WarMailStatusService();
    let trackedTarget: WarMailTrackedTarget | null = buildTrackedTarget();
    const cleanup = vi.fn().mockImplementation(async () => {
      trackedTarget = null;
      return true;
    });

    const first = await service.resolveStatus({
      client: buildClient({
        messageError: { code: 10008, message: "Unknown Message" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget,
      onDefinitiveMissing: cleanup,
    });
    const second = await service.resolveStatus({
      client: buildClient({}),
      guildId: "guild-1",
      clanTag: "AAA111",
      matchesCurrentMailConfig: true,
      trackedTarget,
      onDefinitiveMissing: cleanup,
    });

    expect(first.status).toBe("tracked_post_missing");
    expect(second.status).toBe("no_post_tracked");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

