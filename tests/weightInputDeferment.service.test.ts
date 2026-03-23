import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  clanNotifyConfig: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  getDueDefermentStagesForTest,
  normalizePlayerTag,
  parseDeferWeightInput,
  processWeightInputDefermentStages,
} from "../src/services/WeightInputDefermentService";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

type MutableRecord = {
  id: string;
  guildId: string;
  scopeKey: string;
  clanTag: string | null;
  playerTag: string;
  deferredWeight: number;
  status: string;
  createdAt: Date;
  reminded48At: Date | null;
  escalated5dAt: Date | null;
  summarized7dAt: Date | null;
  processingLockToken: string | null;
  processingLockExpiresAt: Date | null;
};

function setupStatefulDefermentMocks(record: MutableRecord) {
  prismaMock.weightInputDeferment.findMany.mockImplementation(async () => [record]);
  prismaMock.weightInputDeferment.findFirst.mockImplementation(async (input: any) => {
    if (input?.where?.processingLockToken && record.processingLockToken === input.where.processingLockToken) {
      return { ...record };
    }
    return null;
  });
  prismaMock.weightInputDeferment.updateMany.mockImplementation(async (input: any) => {
    const data = input?.data ?? {};
    const where = input?.where ?? {};
    if (Object.prototype.hasOwnProperty.call(data, "processingLockToken") &&
      Object.prototype.hasOwnProperty.call(data, "processingLockExpiresAt") &&
      data.processingLockToken) {
      if (record.status !== "open") return { count: 0 };
      const expired =
        !record.processingLockExpiresAt || record.processingLockExpiresAt.getTime() < new Date().getTime();
      if (!expired) return { count: 0 };
      record.processingLockToken = data.processingLockToken;
      record.processingLockExpiresAt = data.processingLockExpiresAt;
      return { count: 1 };
    }
    if (
      Object.prototype.hasOwnProperty.call(data, "processingLockToken") &&
      data.processingLockToken === null &&
      !Object.prototype.hasOwnProperty.call(data, "status") &&
      where?.processingLockToken &&
      where.processingLockToken === record.processingLockToken
    ) {
      record.processingLockToken = null;
      record.processingLockExpiresAt = null;
      return { count: 1 };
    }
    if (where?.processingLockToken && where.processingLockToken === record.processingLockToken) {
      if (data.status === "resolved" && record.status === "open") {
        record.status = "resolved";
        record.processingLockToken = null;
        record.processingLockExpiresAt = null;
        return { count: 1 };
      }
      if (Object.prototype.hasOwnProperty.call(data, "reminded48At") && !record.reminded48At) {
        record.reminded48At = data.reminded48At;
        return { count: 1 };
      }
      if (Object.prototype.hasOwnProperty.call(data, "escalated5dAt") && !record.escalated5dAt) {
        record.escalated5dAt = data.escalated5dAt;
        return { count: 1 };
      }
      if (Object.prototype.hasOwnProperty.call(data, "summarized7dAt") && !record.summarized7dAt) {
        record.summarized7dAt = data.summarized7dAt;
        return { count: 1 };
      }
    }
    return { count: 0 };
  });
}

describe("WeightInputDefermentService helpers", () => {
  it("normalizes valid tags and rejects invalid tags", () => {
    expect(normalizePlayerTag("pyl0289")).toBe("#PYL0289");
    expect(normalizePlayerTag("#pyl0289")).toBe("#PYL0289");
    expect(normalizePlayerTag("")).toBe("");
    expect(normalizePlayerTag("ABCX123")).toBe("");
  });

  it("parses defer weights in numeric and k-form inputs", () => {
    expect(parseDeferWeightInput("145000")).toBe(145000);
    expect(parseDeferWeightInput("145,000")).toBe(145000);
    expect(parseDeferWeightInput("145k")).toBe(145000);
    expect(parseDeferWeightInput("0")).toBeNull();
    expect(parseDeferWeightInput("abc")).toBeNull();
  });

  it("returns deterministic catch-up stage ordering", () => {
    const now = new Date("2026-03-14T00:00:00.000Z");
    const createdAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const stages = getDueDefermentStagesForTest(
      {
        createdAt,
        reminded48At: null,
        escalated5dAt: null,
        summarized7dAt: null,
      },
      now
    );
    expect(stages).toEqual(["48h", "5d", "7d"]);
  });
});

describe("WeightInputDefermentService lifecycle processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi
      .spyOn(CommandPermissionService.prototype, "getFwaLeaderRoleId")
      .mockResolvedValue("role-global-leader");
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.clanNotifyConfig.findFirst.mockResolvedValue({
      guildId: "guild-1",
      clanTag: "#AAA111",
      channelId: "channel-1",
      roleId: "role-1",
      pingEnabled: true,
      embedEnabled: true,
    });
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#AAA111",
      name: "Alpha",
      notifyChannelId: "channel-1",
      notifyRole: "role-1",
      logChannelId: null,
      mailChannelId: null,
    });
  });

  it("reroutes reminders to the player's current tracked clan log channel and pings guild-wide fwa leader role", async () => {
    const record: MutableRecord = {
      id: "row-1",
      guildId: "guild-1",
      scopeKey: "guild:guild-1|clan:AAA111",
      clanTag: "#AAA111",
      playerTag: "#ABC0289",
      deferredWeight: 145000,
      status: "open",
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      reminded48At: null,
      escalated5dAt: null,
      summarized7dAt: null,
      processingLockToken: null,
      processingLockExpiresAt: null,
    };
    setupStatefulDefermentMocks(record);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#BBB222",
        weight: 146000,
        sourceSyncedAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#BBB222",
        name: "Bravo",
        logChannelId: "channel-2",
        clanRoleId: "role-lead-2",
      },
    ]);
    const send = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      send,
    });
    const client = {
      channels: {
        fetch,
      },
    } as any;

    await processWeightInputDefermentStages(client, "guild-1");

    expect(fetch).toHaveBeenCalledWith("channel-2");
    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[0]?.[0]?.content)).toContain("48h");
    expect(String(send.mock.calls[0]?.[0]?.content)).toContain(
      "<@&role-global-leader>",
    );
    expect(String(send.mock.calls[0]?.[0]?.content)).toContain("Current clan: Bravo (#BBB222)");
    expect(String(send.mock.calls[0]?.[0]?.content)).not.toContain("<@&role-1>");
    expect(String(send.mock.calls[0]?.[0]?.content)).not.toContain(
      "<@&role-lead-2>",
    );
    expect(String(send.mock.calls[1]?.[0]?.content)).toContain("5d");
    expect(String(send.mock.calls[2]?.[0]?.content)).toContain("7d");
    expect(record.reminded48At).toBeTruthy();
    expect(record.escalated5dAt).toBeTruthy();
    expect(record.summarized7dAt).toBeTruthy();
  });

  it("auto-resolves open deferments when current weight already matches deferredWeight", async () => {
    const record: MutableRecord = {
      id: "row-auto-resolve",
      guildId: "guild-1",
      scopeKey: "guild:guild-1|clan:AAA111",
      clanTag: "#AAA111",
      playerTag: "#ABC0289",
      deferredWeight: 145000,
      status: "open",
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      reminded48At: null,
      escalated5dAt: null,
      summarized7dAt: null,
      processingLockToken: null,
      processingLockExpiresAt: null,
    };
    setupStatefulDefermentMocks(record);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#AAA111",
        name: "Alpha",
        logChannelId: "channel-1",
        clanRoleId: "role-lead-1",
      },
    ]);
    const send = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      send,
    });
    const client = {
      channels: {
        fetch,
      },
    } as any;

    await processWeightInputDefermentStages(client, "guild-1");

    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(record.status).toBe("resolved");
    expect(record.reminded48At).toBeNull();
    expect(record.escalated5dAt).toBeNull();
    expect(record.summarized7dAt).toBeNull();
  });

  it("skips pinging when player is not in current tracked/alliance membership", async () => {
    const record: MutableRecord = {
      id: "row-missing-member",
      guildId: "guild-1",
      scopeKey: "guild:guild-1|clan:AAA111",
      clanTag: "#AAA111",
      playerTag: "#ABC0289",
      deferredWeight: 145000,
      status: "open",
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      reminded48At: null,
      escalated5dAt: null,
      summarized7dAt: null,
      processingLockToken: null,
      processingLockExpiresAt: null,
    };
    setupStatefulDefermentMocks(record);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      send,
    });
    const client = {
      channels: {
        fetch,
      },
    } as any;

    await processWeightInputDefermentStages(client, "guild-1");

    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(record.status).toBe("open");
    expect(record.reminded48At).toBeNull();
    expect(record.escalated5dAt).toBeNull();
    expect(record.summarized7dAt).toBeNull();
  });

  it("does not fall back to tracked clan role when fwa leader role is unset", async () => {
    vi
      .spyOn(CommandPermissionService.prototype, "getFwaLeaderRoleId")
      .mockResolvedValueOnce(null);

    const record: MutableRecord = {
      id: "row-no-leader-role",
      guildId: "guild-1",
      scopeKey: "guild:guild-1|clan:AAA111",
      clanTag: "#AAA111",
      playerTag: "#ABC0289",
      deferredWeight: 145000,
      status: "open",
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      reminded48At: null,
      escalated5dAt: null,
      summarized7dAt: null,
      processingLockToken: null,
      processingLockExpiresAt: null,
    };
    setupStatefulDefermentMocks(record);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        weight: 140000,
        sourceSyncedAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#AAA111",
        name: "Alpha",
        logChannelId: "channel-1",
        clanRoleId: "role-lead-1",
      },
    ]);
    const send = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send,
        }),
      },
    } as any;

    await processWeightInputDefermentStages(client, "guild-1");

    expect(send).toHaveBeenCalledTimes(2);
    const firstContent = String(send.mock.calls[0]?.[0]?.content ?? "");
    expect(firstContent).not.toContain("<@&");
    expect(firstContent).not.toContain("<@&role-lead-1>");
  });

  it("keeps stage unset when delivery fails so later runs can retry", async () => {
    const record: MutableRecord = {
      id: "row-2",
      guildId: "guild-1",
      scopeKey: "guild:guild-1|clan:AAA111",
      clanTag: "#AAA111",
      playerTag: "#ABC0289",
      deferredWeight: 145000,
      status: "open",
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      reminded48At: null,
      escalated5dAt: null,
      summarized7dAt: null,
      processingLockToken: null,
      processingLockExpiresAt: null,
    };
    setupStatefulDefermentMocks(record);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        weight: 140000,
        sourceSyncedAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#AAA111",
        name: "Alpha",
        logChannelId: "channel-1",
        clanRoleId: "role-lead-1",
      },
    ]);
    const send = vi.fn().mockRejectedValue(new Error("send failed"));
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send,
        }),
      },
    } as any;

    await processWeightInputDefermentStages(client, "guild-1");

    expect(send).toHaveBeenCalledTimes(1);
    expect(record.reminded48At).toBeNull();
    expect(record.escalated5dAt).toBeNull();
    expect(record.summarized7dAt).toBeNull();
  });
});
