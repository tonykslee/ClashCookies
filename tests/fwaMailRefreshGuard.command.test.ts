import { afterEach, describe, expect, it, vi } from "vitest";
import { WarMailLifecycleService } from "../src/services/WarMailLifecycleService";
import {
  refreshWarMailPostByResolvedTargetForTest,
  setFwaMailRefreshRendererForTest,
} from "../src/commands/Fwa";

function buildPostedMessage(params: {
  warId: string;
  opponentTag: string;
  content?: string;
}) {
  const edit = vi.fn().mockResolvedValue(undefined);
  return {
    id: "message-1",
    content: params.content ?? "Old war mail content",
    embeds: [
      {
        title: "Event: War Started - Example (#AAA111)",
        footer: { text: `War ID: ${params.warId}` },
        fields: [
          {
            name: "Opponent",
            value: `Enemy Clan (#${params.opponentTag})`,
          },
        ],
      },
    ],
    edit,
  };
}

function buildRefreshClient(message: ReturnType<typeof buildPostedMessage>) {
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: vi.fn().mockResolvedValue(message),
    },
  };
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
    },
  } as any;
}

function buildRenderedMail(overrides: Partial<any>) {
  return {
    embed: { toJSON: () => ({}) },
    planText: "Resolved plan",
    inferredMatchType: false,
    mailChannelId: "mail-channel-1",
    clanRoleId: null,
    warId: 1001,
    opponentTag: "#2NEW",
    warStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
    freezeRefresh: false,
    unavailableReasons: [],
    matchType: "FWA",
    expectedOutcome: "WIN",
    mailRevisionDecision: {
      confirmedRevisionBaseline: {
        warId: "1001",
        opponentTag: "#2NEW",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
      effectiveRevisionFields: {
        warId: "1001",
        opponentTag: "#2NEW",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
    },
    renderResult: {
      kind: "resolved_fwa",
      matchType: "FWA",
      expectedOutcome: "WIN",
    },
    ...overrides,
  } as any;
}

describe("routine war-mail refresh guard", () => {
  afterEach(() => {
    setFwaMailRefreshRendererForTest(null);
    vi.restoreAllMocks();
  });

  it.each(["WIN", "LOSE"] as const)(
    "skips editing a posted FWA %s mail when the same-war rerender is unresolved",
    async (previousOutcome) => {
      const message = buildPostedMessage({
        warId: "1001",
        opponentTag: "2NEW",
        content: `Posted ${previousOutcome} mail`,
      });
      const client = buildRefreshClient(message);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const markPostedSpy = vi
        .spyOn(WarMailLifecycleService.prototype, "markPosted")
        .mockResolvedValue(true);
      setFwaMailRefreshRendererForTest(async () =>
        buildRenderedMail({
          planText: "FWA plan unavailable (expected outcome unknown).",
          expectedOutcome: "UNKNOWN",
          mailRevisionDecision: {
            confirmedRevisionBaseline: null,
            effectiveRevisionFields: {
              warId: "1001",
              opponentTag: "#2NEW",
              matchType: "FWA",
              expectedOutcome: "UNKNOWN",
            },
          },
          renderResult: {
            kind: "unresolved_fwa_expected_outcome",
            matchType: "FWA",
            expectedOutcome: "UNKNOWN",
          },
        }),
      );

      const result = await refreshWarMailPostByResolvedTargetForTest({
        client,
        guildId: "guild-1",
        tag: "#AAA111",
        channelId: "channel-1",
        messageId: message.id,
        expectedWarId: "1001",
        expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
        fetchReason: "mail_refresh",
        routine: true,
        lifecycleStatus: "POSTED",
      });

      expect(result).toBe("skipped");
      expect(message.edit).not.toHaveBeenCalled();
      expect(message.content).toBe(`Posted ${previousOutcome} mail`);
      expect(message.embeds[0]?.footer?.text).toBe("War ID: 1001");
      expect(markPostedSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "event=war_mail_refresh result=skipped reason=expected_outcome_unknown",
        ),
      );
      expect(
        infoSpy.mock.calls.some((call) =>
          String(call[0]).includes("confirmed_baseline=0"),
        ),
      ).toBe(true);
    },
  );

  it.each(["WIN", "LOSE"] as const)(
    "skips the exact production-incident UNKNOWN rerender for a posted FWA %s mail",
    async (previousOutcome) => {
      const message = buildPostedMessage({
        warId: "1001",
        opponentTag: "2NEW",
        content: `Posted ${previousOutcome} mail`,
      });
      const client = buildRefreshClient(message);
      const markPostedSpy = vi
        .spyOn(WarMailLifecycleService.prototype, "markPosted")
        .mockResolvedValue(true);
      setFwaMailRefreshRendererForTest(async () =>
        buildRenderedMail({
          planText: "FWA plan unavailable (expected outcome unknown).",
          warId: null,
          warStartMs: null,
          opponentTag: null,
          matchType: "UNKNOWN",
          expectedOutcome: null,
          mailRevisionDecision: {
            confirmedRevisionBaseline: null,
            effectiveRevisionFields: null,
          },
          renderResult: {
            kind: "unresolved_match_type",
            matchType: "UNKNOWN",
            expectedOutcome: "UNKNOWN",
            unavailableReasons: [],
          },
        }),
      );

      const result = await refreshWarMailPostByResolvedTargetForTest({
        client,
        guildId: "guild-1",
        tag: "#AAA111",
        channelId: "channel-1",
        messageId: message.id,
        expectedWarId: "1001",
        expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
        fetchReason: "mail_refresh",
        routine: true,
        lifecycleStatus: "POSTED",
      });

      expect(result).toBe("skipped");
      expect(message.edit).not.toHaveBeenCalled();
      expect(message.content).toBe(`Posted ${previousOutcome} mail`);
      expect(markPostedSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["WIN", "LOSE"] as const)(
    "skips editing a posted FWA %s mail when the rerender loses the match type",
    async (previousOutcome) => {
      const message = buildPostedMessage({
        warId: "1001",
        opponentTag: "2NEW",
        content: `Posted ${previousOutcome} mail`,
      });
      const client = buildRefreshClient(message);
      const markPostedSpy = vi
        .spyOn(WarMailLifecycleService.prototype, "markPosted")
        .mockResolvedValue(true);
      setFwaMailRefreshRendererForTest(async () =>
        buildRenderedMail({
          planText: "FWA plan unavailable (expected outcome unknown).",
          matchType: "UNKNOWN",
          expectedOutcome: null,
          mailRevisionDecision: {
            confirmedRevisionBaseline: null,
            effectiveRevisionFields: null,
          },
          renderResult: {
            kind: "unresolved_match_type",
            matchType: "UNKNOWN",
            expectedOutcome: "UNKNOWN",
            unavailableReasons: [],
          },
        }),
      );

      const result = await refreshWarMailPostByResolvedTargetForTest({
        client,
        guildId: "guild-1",
        tag: "#AAA111",
        channelId: "channel-1",
        messageId: message.id,
        expectedWarId: "1001",
        expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
        fetchReason: "mail_refresh",
        routine: true,
        lifecycleStatus: "POSTED",
      });

      expect(result).toBe("skipped");
      expect(message.edit).not.toHaveBeenCalled();
      expect(message.content).toBe(`Posted ${previousOutcome} mail`);
      expect(message.embeds[0]?.footer?.text).toBe("War ID: 1001");
      expect(markPostedSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["war id", { warId: null }, "war_id_missing"],
    ["war start", { warStartMs: null }, "war_start_missing"],
    ["opponent", { opponentTag: null }, "opponent_missing"],
  ] as const)(
    "skips editing a posted FWA mail when the rendered %s is missing",
    async (_label, overrides, _expectedReason) => {
      const message = buildPostedMessage({
        warId: "1001",
        opponentTag: "2NEW",
      });
      const client = buildRefreshClient(message);
      const markPostedSpy = vi
        .spyOn(WarMailLifecycleService.prototype, "markPosted")
        .mockResolvedValue(true);
      setFwaMailRefreshRendererForTest(async () =>
        buildRenderedMail({
          ...overrides,
          planText: "FWA plan unavailable (expected outcome unknown).",
          matchType: "UNKNOWN",
          expectedOutcome: null,
          mailRevisionDecision: {
            confirmedRevisionBaseline: null,
            effectiveRevisionFields: null,
          },
          renderResult: {
            kind: "unresolved_match_type",
            matchType: "UNKNOWN",
            expectedOutcome: "UNKNOWN",
            unavailableReasons: [],
          },
        }),
      );

      const result = await refreshWarMailPostByResolvedTargetForTest({
        client,
        guildId: "guild-1",
        tag: "#AAA111",
        channelId: "channel-1",
        messageId: message.id,
        expectedWarId: "1001",
        expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
        fetchReason: "mail_refresh",
        routine: true,
        lifecycleStatus: "POSTED",
      });

      expect(result).toBe("skipped");
      expect(message.edit).not.toHaveBeenCalled();
      expect(message.content).toBe("Old war mail content");
      expect(message.embeds[0]?.footer?.text).toBe("War ID: 1001");
      expect(markPostedSpy).not.toHaveBeenCalled();
    },
  );

  it("skips editing a posted mail when the render is generically unavailable", async () => {
    const message = buildPostedMessage({
      warId: "1001",
      opponentTag: "2NEW",
    });
    const client = buildRefreshClient(message);
    const markPostedSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "markPosted")
      .mockResolvedValue(true);
    setFwaMailRefreshRendererForTest(async () =>
      buildRenderedMail({
        planText: "Rendered plan unavailable",
        matchType: "FWA",
        expectedOutcome: "UNKNOWN",
        mailRevisionDecision: {
          confirmedRevisionBaseline: null,
          effectiveRevisionFields: null,
        },
        renderResult: {
          kind: "unavailable",
          matchType: "FWA",
          expectedOutcome: "UNKNOWN",
          unavailableReasons: ["Tracked clan mail channel is not configured."],
        },
      }),
    );

    const result = await refreshWarMailPostByResolvedTargetForTest({
      client,
      guildId: "guild-1",
      tag: "#AAA111",
      channelId: "channel-1",
      messageId: message.id,
      expectedWarId: "1001",
      expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
      fetchReason: "mail_refresh",
      routine: true,
      lifecycleStatus: "POSTED",
    });

    expect(result).toBe("skipped");
    expect(message.edit).not.toHaveBeenCalled();
    expect(markPostedSpy).not.toHaveBeenCalled();
  });

  it.each(["WIN", "LOSE"] as const)(
    "still edits a posted FWA %s mail when the same-war rerender is resolved",
    async (outcome) => {
      const message = buildPostedMessage({
        warId: "1001",
        opponentTag: "2NEW",
      });
      const client = buildRefreshClient(message);
      const markPostedSpy = vi
        .spyOn(WarMailLifecycleService.prototype, "markPosted")
        .mockResolvedValue(true);
      setFwaMailRefreshRendererForTest(async () =>
        buildRenderedMail({
          planText: `${outcome} plan`,
          expectedOutcome: outcome,
          renderResult: {
            kind: "resolved_fwa",
            matchType: "FWA",
            expectedOutcome: outcome,
          },
          mailRevisionDecision: {
            confirmedRevisionBaseline: {
              warId: "1001",
              opponentTag: "#2NEW",
              matchType: "FWA",
              expectedOutcome: outcome,
            },
            effectiveRevisionFields: {
              warId: "1001",
              opponentTag: "#2NEW",
              matchType: "FWA",
              expectedOutcome: outcome,
            },
          },
        }),
      );

      const result = await refreshWarMailPostByResolvedTargetForTest({
        client,
        guildId: "guild-1",
        tag: "#AAA111",
        channelId: "channel-1",
        messageId: message.id,
        expectedWarId: "1001",
        expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
        fetchReason: "mail_refresh",
        routine: true,
        lifecycleStatus: "POSTED",
      });

      expect(result).toBe("refreshed");
      expect(message.edit).toHaveBeenCalledTimes(1);
      expect(markPostedSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["BL", "MM"] as const)(
    "keeps %s refresh behavior unchanged",
    async (matchType) => {
      const message = buildPostedMessage({
        warId: "1001",
        opponentTag: "2NEW",
      });
      const client = buildRefreshClient(message);
      const markPostedSpy = vi
        .spyOn(WarMailLifecycleService.prototype, "markPosted")
        .mockResolvedValue(true);
      setFwaMailRefreshRendererForTest(async () =>
        buildRenderedMail({
          planText: `${matchType} plan`,
          matchType,
          expectedOutcome: null,
          renderResult: {
            kind: "resolved_blmm",
            matchType,
            expectedOutcome: null,
          },
          mailRevisionDecision: {
            confirmedRevisionBaseline: {
              warId: "1001",
              opponentTag: "#2NEW",
              matchType,
              expectedOutcome: null,
            },
            effectiveRevisionFields: {
              warId: "1001",
              opponentTag: "#2NEW",
              matchType,
              expectedOutcome: null,
            },
          },
        }),
      );

      const result = await refreshWarMailPostByResolvedTargetForTest({
        client,
        guildId: "guild-1",
        tag: "#AAA111",
        channelId: "channel-1",
        messageId: message.id,
        expectedWarId: "1001",
        expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
        fetchReason: "mail_refresh",
        routine: true,
        lifecycleStatus: "POSTED",
      });

      expect(result).toBe("refreshed");
      expect(message.edit).toHaveBeenCalledTimes(1);
      expect(markPostedSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("freezes a refresh when the rendered mail belongs to a different physical war", async () => {
    const message = buildPostedMessage({
      warId: "1001",
      opponentTag: "2OLD",
    });
    const client = buildRefreshClient(message);
    const markPostedSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "markPosted")
      .mockResolvedValue(true);
    setFwaMailRefreshRendererForTest(async () =>
      buildRenderedMail({
        warId: 2002,
        opponentTag: "#2NEW",
        renderResult: {
          kind: "resolved_fwa",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
      }),
    );

    const result = await refreshWarMailPostByResolvedTargetForTest({
      client,
      guildId: "guild-1",
      tag: "#AAA111",
      channelId: "channel-1",
      messageId: message.id,
      expectedWarId: "1001",
      expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
      fetchReason: "mail_refresh",
      routine: true,
      lifecycleStatus: "POSTED",
    });

    expect(result).toBe("frozen");
    expect(message.edit).toHaveBeenCalledWith({
      components: [],
    });
    expect(markPostedSpy).not.toHaveBeenCalled();
  });

  it("retries successfully after a skipped render and keeps the lifecycle posted", async () => {
    const message = buildPostedMessage({
      warId: "1001",
      opponentTag: "2NEW",
    });
    const client = buildRefreshClient(message);
    const markPostedSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "markPosted")
      .mockResolvedValue(true);

    setFwaMailRefreshRendererForTest(async () =>
      buildRenderedMail({
        planText: "FWA plan unavailable (expected outcome unknown).",
        matchType: "UNKNOWN",
        expectedOutcome: null,
        warId: null,
        warStartMs: null,
        opponentTag: null,
        mailRevisionDecision: {
          confirmedRevisionBaseline: null,
          effectiveRevisionFields: null,
        },
        renderResult: {
          kind: "unresolved_match_type",
          matchType: "UNKNOWN",
          expectedOutcome: "UNKNOWN",
          unavailableReasons: [],
        },
      }),
    );

    const skipped = await refreshWarMailPostByResolvedTargetForTest({
      client,
      guildId: "guild-1",
      tag: "#AAA111",
      channelId: "channel-1",
      messageId: message.id,
      expectedWarId: "1001",
      expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
      fetchReason: "mail_refresh",
      routine: true,
      lifecycleStatus: "POSTED",
    });

    expect(skipped).toBe("skipped");
    expect(message.edit).not.toHaveBeenCalled();
    expect(markPostedSpy).not.toHaveBeenCalled();

    setFwaMailRefreshRendererForTest(async () =>
      buildRenderedMail({
        planText: "Resolved WIN plan",
        expectedOutcome: "WIN",
        renderResult: {
          kind: "resolved_fwa",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
        mailRevisionDecision: {
          confirmedRevisionBaseline: {
            warId: "1001",
            opponentTag: "#2NEW",
            matchType: "FWA",
            expectedOutcome: "WIN",
          },
          effectiveRevisionFields: {
            warId: "1001",
            opponentTag: "#2NEW",
            matchType: "FWA",
            expectedOutcome: "WIN",
          },
        },
      }),
    );

    const refreshed = await refreshWarMailPostByResolvedTargetForTest({
      client,
      guildId: "guild-1",
      tag: "#AAA111",
      channelId: "channel-1",
      messageId: message.id,
      expectedWarId: "1001",
      expectedWarStartMs: new Date("2026-03-12T00:00:00.000Z").getTime(),
      fetchReason: "mail_refresh",
      routine: true,
      lifecycleStatus: "POSTED",
    });

    expect(refreshed).toBe("refreshed");
    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(markPostedSpy).toHaveBeenCalledTimes(1);
  });
});
