import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
  },
  clanWarPlan: {
    findFirst: vi.fn(),
  },
  fwaPoliceClanTemplate: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  fwaPoliceDefaultTemplate: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  fwaPoliceHandledViolation: {
    create: vi.fn(),
    update: vi.fn(),
  },
  warAttacks: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForClanMembers: vi.fn(),
}));

const botLogServiceMock = vi.hoisted(() => ({
  getChannelId: vi.fn(),
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

vi.mock("../src/services/BotLogChannelService", () => ({
  BotLogChannelService: vi.fn().mockImplementation(() => ({
    getChannelId: botLogServiceMock.getChannelId,
  })),
}));

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
      loseStyle: "TRIPLE_TOP_30",
      fwaPoliceDmEnabled: false,
      fwaPoliceLogEnabled: false,
      logChannelId: "channel-1",
      notifyChannelId: "channel-2",
      mailChannelId: null,
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Alpha",
        loseStyle: "TRIPLE_TOP_30",
        fwaPoliceDmEnabled: false,
        fwaPoliceLogEnabled: false,
        logChannelId: "channel-1",
      },
    ]);
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
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.clanWarPlan.findFirst.mockResolvedValue(null);
    prismaMock.fwaPoliceClanTemplate.findUnique.mockResolvedValue(null);
    prismaMock.fwaPoliceDefaultTemplate.findUnique.mockResolvedValue(null);
    prismaMock.fwaPoliceClanTemplate.upsert.mockResolvedValue({});
    prismaMock.fwaPoliceDefaultTemplate.upsert.mockResolvedValue({});
    prismaMock.fwaPoliceClanTemplate.deleteMany.mockResolvedValue({});
    prismaMock.fwaPoliceDefaultTemplate.deleteMany.mockResolvedValue({});
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);
    botLogServiceMock.getChannelId.mockResolvedValue(null);
    prismaMock.warAttacks.findFirst.mockResolvedValue({
      attackSeenAt: new Date("2026-03-12T00:45:00.000Z"),
      warEndTime: new Date("2026-03-13T00:00:00.000Z"),
    });
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        trueStars: 1,
      },
      {
        trueStars: 2,
      },
    ]);
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

  it("rejects unknown placeholders on clan template save", async () => {
    const service = new FwaPoliceService();
    const result = await service.setClanTemplate({
      clanTag: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      template: "Bad token {unknown_placeholder}",
    });

    expect(result).toEqual({
      ok: false,
      error: "INVALID_PLACEHOLDER",
      detail: "unknown_placeholder",
    });
    expect(prismaMock.fwaPoliceClanTemplate.upsert).not.toHaveBeenCalled();
  });

  it("resolves preview source precedence as Custom over Default over Built-in", async () => {
    prismaMock.fwaPoliceClanTemplate.findUnique.mockResolvedValue({
      template: "Clan custom {offender}",
    });
    prismaMock.fwaPoliceDefaultTemplate.findUnique.mockResolvedValue({
      template: "Global default {offender}",
    });

    const service = new FwaPoliceService();
    const bundle = await service.getTemplatePreviewBundle({
      client: {} as any,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      sampleUserId: "111111111111111111",
    });

    expect(bundle).not.toBeNull();
    const first = bundle?.rows[0];
    expect(first?.effectiveSource).toBe("Custom");
    expect(first?.effectiveTemplate).toBe("Clan custom {offender}");
  });

  it("fails LOG sample send when clan log channel is not configured", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: null,
      notifyChannelId: null,
      mailChannelId: null,
    });
    const service = new FwaPoliceService();
    const result = await service.sendSampleMessage({
      client: {} as any,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      destination: "LOG",
      requestingUserId: "111111111111111111",
    });

    expect(result).toEqual({
      ok: false,
      error: "LOG_CHANNEL_NOT_CONFIGURED",
    });
  });

  it("uses /bot-logs fallback for LOG sample send when tracked log channel is missing", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: null,
      notifyChannelId: null,
      mailChannelId: null,
    });
    botLogServiceMock.getChannelId.mockResolvedValue("channel-bot-log");
    const logSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: logSend,
        }),
      },
      users: {
        fetch: vi.fn(),
      },
    } as any;

    const service = new FwaPoliceService();
    const result = await service.sendSampleMessage({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      destination: "LOG",
      requestingUserId: "111111111111111111",
    });

    expect(botLogServiceMock.getChannelId).toHaveBeenCalledWith("guild-1");
    expect(client.channels.fetch).toHaveBeenCalledWith("channel-bot-log");
    expect(logSend).toHaveBeenCalledTimes(1);
    const sentPayload = logSend.mock.calls[0]?.[0];
    expect(String(sentPayload?.content ?? "")).toContain("<@111111111111111111>");
    expect(sentPayload?.allowedMentions).toEqual({
      users: ["111111111111111111"],
      parse: [],
    });
    const sampleEmbed = sentPayload?.embeds?.[0]?.toJSON?.() ?? null;
    expect(String(sampleEmbed?.description ?? "")).toContain(
      "**Violation Time**: 23h 15m left | **Clan stars before hit**: ?★",
    );
    expect(result).toEqual({
      ok: true,
      deliveredTo: "LOG",
      rendered: expect.any(String),
    });
  });

  it("does not fall back to notify/mail channels for police LOG sample send", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: null,
      notifyChannelId: "channel-notify",
      mailChannelId: "channel-mail",
    });
    botLogServiceMock.getChannelId.mockResolvedValue(null);
    const client = {
      channels: {
        fetch: vi.fn(),
      },
      users: {
        fetch: vi.fn(),
      },
    } as any;

    const service = new FwaPoliceService();
    const result = await service.sendSampleMessage({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      destination: "LOG",
      requestingUserId: "111111111111111111",
    });

    expect(result).toEqual({
      ok: false,
      error: "LOG_CHANNEL_NOT_CONFIGURED",
    });
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("resolves clan status LOG destination with tracked-clan priority then /bot-logs fallback", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Alpha",
        loseStyle: "TRIPLE_TOP_30",
        fwaPoliceDmEnabled: true,
        fwaPoliceLogEnabled: true,
        logChannelId: null,
      },
    ]);
    botLogServiceMock.getChannelId.mockResolvedValue("channel-bot-log");
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: vi.fn(),
        }),
      },
    } as any;
    const service = new FwaPoliceService();

    const result = await service.getStatusReport({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.scope).toBe("clan");
      expect(result.report.clan?.effectiveLogChannelSource).toBe("bot_logs");
      expect(result.report.clan?.effectiveLogChannelId).toBe("channel-bot-log");
      expect(result.report.warnings).toEqual([]);
    }
  });

  it("surfaces unresolved-channel warning in clan status when no tracked log or /bot-logs fallback exists", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Alpha",
        loseStyle: "TRIPLE_TOP_30",
        fwaPoliceDmEnabled: true,
        fwaPoliceLogEnabled: true,
        logChannelId: null,
      },
    ]);
    botLogServiceMock.getChannelId.mockResolvedValue(null);
    const client = {
      channels: {
        fetch: vi.fn(),
      },
    } as any;
    const service = new FwaPoliceService();

    const result = await service.getStatusReport({
      client,
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.clan?.effectiveLogChannelSource).toBe("none");
      expect(result.report.clan?.effectiveLogChannelId).toBeNull();
      expect(result.report.warnings.some((line) => line.includes("No effective log channel resolved"))).toBe(true);
    }
  });

  it("uses canonical compliance evaluation and sends DM only when dm toggle is enabled", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
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
      loseStyle: "TRIPLE_TOP_30",
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
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
    const sentPayload = logSend.mock.calls[0]?.[0];
    const embedJson = sentPayload?.embeds?.[0]?.toJSON?.() ?? null;
    expect(embedJson?.title ?? null).toBeNull();
    expect(Number(embedJson?.color ?? 0)).toBe(0xed4245);
    expect(String(embedJson?.description ?? "")).toContain(
      "FWA Police - Warplan violation detected",
    );
    expect(String(embedJson?.description ?? "")).toContain("**War**: Alpha FWA-WIN");
    expect(String(embedJson?.description ?? "")).toContain(
      "**Violation Time**: 23h 15m left | **Clan stars before hit**: 3★",
    );
    expect(String(sentPayload?.content ?? "")).toContain(
      "<@222222222222222222>",
    );
    expect(sentPayload?.allowedMentions).toEqual({
      users: ["222222222222222222"],
      parse: [],
    });
    expect(String(embedJson?.fields?.[0]?.name ?? "")).toBe("**Message**");
    expect(String(embedJson?.fields?.[1]?.name ?? "")).toBe(
      "**:yes: Expected**",
    );
    expect(String(embedJson?.fields?.[2]?.name ?? "")).toBe(
      "**:no: Actual**",
    );
    expect(String(embedJson?.fields?.[0]?.value ?? "")).toContain(
      "<@222222222222222222>",
    );
    expect(botLogServiceMock.getChannelId).not.toHaveBeenCalled();
    expect(result.logSent).toBe(1);
    expect(result.dmSent).toBe(0);
  });

  it("renders unknown stars-before-hit when breach chronology is unavailable", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
        notFollowingPlan: [
          buildIssue({
            attackDetails: [
              {
                defenderPosition: 14,
                stars: 3,
                attackOrder: null,
                isBreach: true,
              },
            ],
            breachContext: null,
          }),
        ],
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
    const sentPayload = logSend.mock.calls[0]?.[0];
    const embedJson = sentPayload?.embeds?.[0]?.toJSON?.() ?? null;
    expect(String(embedJson?.description ?? "")).toContain(
      "**Violation Time**: 23h 15m left | **Clan stars before hit**: ?★",
    );
    expect(result.logSent).toBe(1);
  });

  it("falls back to /bot-logs for live police log delivery when tracked log channel is missing", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
      fwaPoliceDmEnabled: false,
      fwaPoliceLogEnabled: true,
      logChannelId: null,
      notifyChannelId: "channel-notify",
      mailChannelId: "channel-mail",
    });
    botLogServiceMock.getChannelId.mockResolvedValue("channel-bot-log");
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
        warEndTime: new Date("2026-03-13T00:00:00.000Z"),
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

    expect(botLogServiceMock.getChannelId).toHaveBeenCalledWith("guild-1");
    expect(client.channels.fetch).toHaveBeenCalledWith("channel-bot-log");
    expect(logSend).toHaveBeenCalledTimes(1);
    expect(result.logSent).toBe(1);
  });

  it("does not send DM or log when canonical compliance returns no remaining violations", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
      loseStyle: "TRIPLE_TOP_30",
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
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
      loseStyle: "TRIPLE_TOP_30",
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
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
      loseStyle: "TRIPLE_TOP_30",
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
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
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
