import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  fwaPoliceHandledViolation: {
    create: vi.fn(),
    update: vi.fn(),
  },
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForClanMembers: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual("../src/services/PlayerLinkService");
  return {
    ...actual,
    listPlayerLinksForClanMembers:
      playerLinkServiceMock.listPlayerLinksForClanMembers,
  };
});

import { FwaPoliceService } from "../src/services/FwaPoliceService";

function buildIssue(overrides?: Record<string, unknown>) {
  return {
    playerTag: "#P2YLC8R0",
    playerName: "Player One",
    playerPosition: 1,
    ruleType: "not_following_plan",
    expectedBehavior: "Mirror triple in strict window.",
    actualBehavior: "#14 (★ ★ ★) : tripled non-mirror in strict window",
    reasonLabel: "tripled non-mirror in strict window",
    attackDetails: [
      {
        defenderPosition: 14,
        stars: 3,
        attackOrder: 2,
        isBreach: true,
      },
    ],
    ...overrides,
  } as any;
}

describe("FwaPoliceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: false,
      fwaPoliceLogEnabled: false,
      logChannelId: "channel-1",
      notifyChannelId: "channel-2",
      mailChannelId: null,
    });
    prismaMock.trackedClan.update.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: false,
    });
    prismaMock.fwaPoliceHandledViolation.create.mockResolvedValue({
      id: "handled-1",
    });
    prismaMock.fwaPoliceHandledViolation.update.mockResolvedValue({});
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);
  });

  it("persists clan police config on tracked clan rows", async () => {
    const service = new FwaPoliceService();
    const saved = await service.setClanConfig({
      clanTag: "#2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });

    expect(saved).toEqual({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: true,
      enableLog: false,
    });
    expect(prismaMock.trackedClan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tag: "#2QG2C08UP" },
        data: {
          fwaPoliceDmEnabled: true,
          fwaPoliceLogEnabled: false,
        },
      }),
    );
  });

  it("uses canonical compliance evaluation and sends DM only when dm toggle is enabled", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: false,
      logChannelId: "channel-1",
      notifyChannelId: null,
      mailChannelId: null,
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      {
        playerTag: "#P2YLC8R0",
        discordUserId: "222222222222222222",
      },
    ]);

    const dmSend = vi.fn().mockResolvedValue({});
    const client = {
      users: {
        fetch: vi.fn().mockResolvedValue({
          createDM: vi.fn().mockResolvedValue({
            send: dmSend,
          }),
        }),
      },
      channels: {
        fetch: vi.fn(),
      },
    } as any;
    const evaluateComplianceForCommand = vi.fn().mockResolvedValue({
      status: "ok",
      report: {
        warId: 12345,
        clanName: "Alpha",
        opponentName: "Bravo",
        notFollowingPlan: [buildIssue()],
      },
    });

    const service = new FwaPoliceService();
    const result = await service.enforceWarViolations({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      warId: 12345,
      warCompliance: { evaluateComplianceForCommand } as any,
    });

    expect(evaluateComplianceForCommand).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      scope: "war_id",
      warId: 12345,
    });
    expect(dmSend).toHaveBeenCalledTimes(1);
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      evaluatedViolations: 1,
      created: 1,
      deduped: 0,
      dmSent: 1,
      logSent: 0,
    });
    expect(prismaMock.fwaPoliceHandledViolation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dmSentAt: expect.any(Date),
        }),
      }),
    );
  });

  it("sends clan-channel log with ping when log toggle is enabled", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: false,
      fwaPoliceLogEnabled: true,
      logChannelId: "channel-1",
      notifyChannelId: null,
      mailChannelId: null,
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      {
        playerTag: "#P2YLC8R0",
        discordUserId: "222222222222222222",
      },
    ]);

    const logSend = vi.fn().mockResolvedValue({});
    const client = {
      users: {
        fetch: vi.fn(),
      },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: logSend,
        }),
      },
    } as any;
    const evaluateComplianceForCommand = vi.fn().mockResolvedValue({
      status: "ok",
      report: {
        warId: 12345,
        clanName: "Alpha",
        opponentName: "Bravo",
        notFollowingPlan: [buildIssue()],
      },
    });

    const service = new FwaPoliceService();
    const result = await service.enforceWarViolations({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      warId: 12345,
      warCompliance: { evaluateComplianceForCommand } as any,
    });

    expect(logSend).toHaveBeenCalledTimes(1);
    expect(String(logSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "<@222222222222222222>",
    );
    expect(String(logSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Expected:",
    );
    expect(String(logSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Actual:",
    );
    expect(String(logSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Violation:",
    );
    expect(result.logSent).toBe(1);
    expect(result.dmSent).toBe(0);
  });

  it("does not send DM or log when canonical compliance returns no remaining violations", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: "channel-1",
      notifyChannelId: null,
      mailChannelId: null,
    });

    const dmSend = vi.fn().mockResolvedValue({});
    const logSend = vi.fn().mockResolvedValue({});
    const client = {
      users: {
        fetch: vi.fn().mockResolvedValue({
          createDM: vi.fn().mockResolvedValue({ send: dmSend }),
        }),
      },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: logSend,
        }),
      },
    } as any;
    const evaluateComplianceForCommand = vi.fn().mockResolvedValue({
      status: "ok",
      report: {
        warId: 12345,
        clanName: "Alpha",
        opponentName: "Bravo",
        notFollowingPlan: [],
      },
    });

    const service = new FwaPoliceService();
    const result = await service.enforceWarViolations({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      warId: 12345,
      warCompliance: { evaluateComplianceForCommand } as any,
    });

    expect(result).toEqual({
      evaluatedViolations: 0,
      created: 0,
      deduped: 0,
      dmSent: 0,
      logSent: 0,
    });
    expect(dmSend).not.toHaveBeenCalled();
    expect(logSend).not.toHaveBeenCalled();
  });

  it("does not resend duplicate handled violations across reevaluations", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: "channel-1",
      notifyChannelId: null,
      mailChannelId: null,
    });
    prismaMock.fwaPoliceHandledViolation.create.mockRejectedValue({
      code: "P2002",
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      {
        playerTag: "#P2YLC8R0",
        discordUserId: "222222222222222222",
      },
    ]);

    const dmSend = vi.fn().mockResolvedValue({});
    const logSend = vi.fn().mockResolvedValue({});
    const client = {
      users: {
        fetch: vi.fn().mockResolvedValue({
          createDM: vi.fn().mockResolvedValue({ send: dmSend }),
        }),
      },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: logSend,
        }),
      },
    } as any;
    const evaluateComplianceForCommand = vi.fn().mockResolvedValue({
      status: "ok",
      report: {
        warId: 12345,
        clanName: "Alpha",
        opponentName: "Bravo",
        notFollowingPlan: [buildIssue()],
      },
    });

    const service = new FwaPoliceService();
    const result = await service.enforceWarViolations({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      warId: 12345,
      warCompliance: { evaluateComplianceForCommand } as any,
    });

    expect(result).toEqual({
      evaluatedViolations: 1,
      created: 0,
      deduped: 1,
      dmSent: 0,
      logSent: 0,
    });
    expect(dmSend).not.toHaveBeenCalled();
    expect(logSend).not.toHaveBeenCalled();
  });

  it("keeps log delivery working when DM delivery fails", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: "channel-1",
      notifyChannelId: null,
      mailChannelId: null,
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      {
        playerTag: "#P2YLC8R0",
        discordUserId: "222222222222222222",
      },
    ]);

    const logSend = vi.fn().mockResolvedValue({});
    const client = {
      users: {
        fetch: vi.fn().mockResolvedValue({
          createDM: vi.fn().mockResolvedValue({
            send: vi.fn().mockRejectedValue(new Error("dm failed")),
          }),
        }),
      },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: logSend,
        }),
      },
    } as any;
    const evaluateComplianceForCommand = vi.fn().mockResolvedValue({
      status: "ok",
      report: {
        warId: 12345,
        clanName: "Alpha",
        opponentName: "Bravo",
        notFollowingPlan: [buildIssue()],
      },
    });

    const service = new FwaPoliceService();
    const result = await service.enforceWarViolations({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      warId: 12345,
      warCompliance: { evaluateComplianceForCommand } as any,
    });

    expect(result.dmSent).toBe(0);
    expect(result.logSent).toBe(1);
    expect(logSend).toHaveBeenCalledTimes(1);
  });
});
