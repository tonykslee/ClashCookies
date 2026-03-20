import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        trackedMessage: prismaMock.trackedMessage,
      });
    }
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return null;
  }),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  batchFwaBaseSwapPingLinesForTest,
  buildFwaBaseSwapActiveWarDmLinesForTest,
  buildFwaBaseSwapBaseErrorDmLinesForTest,
  buildFwaBaseSwapDmContentForTest,
  buildFwaBaseSwapRenderPlanForTest,
  clearFwaBaseSwapSplitPostPayloadsForTest,
  deliverFwaBaseSwapDmMessagesForTest,
  FWA_BASE_SWAP_ACK_EMOJI,
  FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI,
  FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI,
  buildFwaBaseSwapPhaseTimingLineForTest,
  handleFwaBaseSwapSplitPostButton,
  renderFwaBaseSwapAnnouncementForTest,
  setFwaBaseSwapSplitPostPayloadForTest,
} from "../src/commands/Fwa";
import { buildFwaBaseSwapSplitPostCustomId } from "../src/commands/fwa/customIds";
import {
  FwaBaseSwapTrackedMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  TrackedMessageService,
} from "../src/services/TrackedMessageService";

beforeEach(() => {
  clearFwaBaseSwapSplitPostPayloadsForTest();
});

function buildEntry(input: {
  position: number;
  playerTag: string;
  playerName: string;
  section: "war_bases" | "base_errors";
  discordUserId?: string | null;
  townhallLevel?: number | null;
  acknowledged?: boolean;
}): FwaBaseSwapTrackedMetadata["entries"][number] {
  return {
    position: input.position,
    playerTag: input.playerTag,
    playerName: input.playerName,
    discordUserId: input.discordUserId ?? null,
    townhallLevel: input.townhallLevel ?? null,
    section: input.section,
    acknowledged: input.acknowledged ?? false,
  };
}

function buildLayoutLink(input: { townhall: number; layoutLink: string }) {
  return {
    townhall: input.townhall,
    layoutLink: input.layoutLink,
  };
}

describe("FWA base-swap layout links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders TH links in descending order after player sections and before react prompt", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
        buildEntry({
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "base_errors",
          discordUserId: null,
          townhallLevel: 17,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 17,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AAAAARQAAAAI6ppxkTfH3WnNJjWK96bqn",
        }),
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
    });

    const th18Line = `## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>`;
    const th17Line = `## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH17: <https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AAAAARQAAAAI6ppxkTfH3WnNJjWK96bqn>`;
    const reactLine = `👇 React with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`;

    const th18Index = content.indexOf(th18Line);
    const th17Index = content.indexOf(th17Line);
    const reactIndex = content.indexOf(reactLine);
    const playerLineIndex = content.indexOf("#2 - *(unlinked)* - Bravo - :x:");

    expect(th18Index).toBeGreaterThan(-1);
    expect(th17Index).toBeGreaterThan(-1);
    expect(th18Index).toBeLessThan(th17Index);
    expect(playerLineIndex).toBeGreaterThan(-1);
    expect(th18Index).toBeGreaterThan(playerLineIndex);
    expect(reactIndex).toBeGreaterThan(th17Index);
  });

  it("builds preparation-day phase timing lines from prep-end timestamps", () => {
    const line = buildFwaBaseSwapPhaseTimingLineForTest({
      warState: "preparation",
      prepEndMs: 1740000000000,
      warEndMs: 1740003600000,
    });

    expect(line).toBe(
      "## Preparation Day ends <t:1740000000:F> (<t:1740000000:R>)",
    );
  });

  it("builds battle-day phase timing lines from war-end timestamps", () => {
    const line = buildFwaBaseSwapPhaseTimingLineForTest({
      warState: "inWar",
      prepEndMs: 1740000000000,
      warEndMs: 1740003600000,
    });

    expect(line).toBe("## Battle Day ends <t:1740003600:F> (<t:1740003600:R>)");
  });

  it("renders the phase timing line immediately above the acknowledge react line", () => {
    const phaseLine = buildFwaBaseSwapPhaseTimingLineForTest({
      warState: "inWar",
      prepEndMs: 1740000000000,
      warEndMs: 1740003600000,
    });
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
      phaseTimingLine: phaseLine,
    });

    const reactPrompt = `React with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`;
    expect(phaseLine).not.toBeNull();
    expect(content).toContain(`${phaseLine}\n\n`);
    expect(content.indexOf(String(phaseLine))).toBeLessThan(
      content.indexOf(reactPrompt),
    );
  });

  it("omits phase timing lines when current-war timing data is unavailable", () => {
    const missingPrep = buildFwaBaseSwapPhaseTimingLineForTest({
      warState: "preparation",
      prepEndMs: null,
      warEndMs: 1740003600000,
    });
    expect(missingPrep).toBeNull();

    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: missingPrep,
    });

    expect(content).not.toContain("Preparation Day ends");
    expect(content).not.toContain("Battle Day ends");
  });

  it("renders one TH line per townhall even when multiple entries share the TH", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          townhallLevel: 18,
        }),
        buildEntry({
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "base_errors",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
    });

    const th18Occurrences = (content.match(/TH18:/g) ?? []).length;
    expect(th18Occurrences).toBe(1);
  });

  it("uses provided resolved inline emojis when present", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
      alertEmoji: "<a:alert:10001>",
      layoutBulletEmoji: "<a:arrow_arrow:10002>",
    });

    expect(content).toContain(
      "# <a:alert:10001> YOU HAVE AN ACTIVE WAR BASE <a:alert:10001>",
    );
    expect(content).toContain(
      "## <a:arrow_arrow:10002> TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>",
    );
  });

  it("uses unicode fallback inline emojis when resolved emojis are unavailable", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
    });

    expect(content).toContain(
      `# ${FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI} YOU HAVE AN ACTIVE WAR BASE ${FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI}`,
    );
    expect(content).toContain(
      `## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>`,
    );
  });

  it("skips TH lines when no matching RISINGDAWN layout link is available", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          townhallLevel: 18,
        }),
        buildEntry({
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "base_errors",
          townhallLevel: 17,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
    });

    expect(content).toContain("TH18:");
    expect(content).not.toContain("TH17:");
  });

  it("preserves TH links during tracked-message reaction re-renders", async () => {
    const metadata: FwaBaseSwapTrackedMetadata = {
      clanName: "Test Clan",
      createdByUserId: "admin-1",
      createdAtIso: "2026-03-19T00:00:00.000Z",
      alertEmoji: "<a:alert:10001>",
      layoutBulletEmoji: "<a:arrow_arrow:10002>",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "reactor-1",
          townhallLevel: 18,
          acknowledged: false,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
    };

    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: 42,
      messageId: "message-1",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      metadata,
    });
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);

    const service = new TrackedMessageService();
    const message = {
      id: "message-1",
      channelId: "channel-1",
      edit: vi.fn().mockResolvedValue(undefined),
    };

    const changed = await service.handleFwaBaseSwapReaction({
      messageId: "message-1",
      reactorUserId: "reactor-1",
      message,
      render: renderFwaBaseSwapAnnouncementForTest,
    });

    expect(changed).toBe(true);
    expect(message.edit).toHaveBeenCalledTimes(1);
    const editPayload = message.edit.mock.calls[0]?.[0];
    expect(String(editPayload.content)).toContain(
      "## <a:arrow_arrow:10002> TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>"
    );
    expect(String(editPayload.content)).toContain(
      `👇 React with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            layoutLinks: expect.arrayContaining([
              expect.objectContaining({
                townhall: 18,
              }),
            ]),
          }),
        }),
      })
    );
  });

  it("dedupes allowedMentions users during tracked-message reaction re-renders", async () => {
    const metadata: FwaBaseSwapTrackedMetadata = {
      clanName: "Test Clan",
      createdByUserId: "admin-1",
      createdAtIso: "2026-03-19T00:00:00.000Z",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "reactor-1",
          acknowledged: false,
        }),
        buildEntry({
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "base_errors",
          discordUserId: "reactor-1",
          acknowledged: false,
        }),
      ],
      layoutLinks: [],
    };

    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: 42,
      messageId: "message-1",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      metadata,
    });
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);

    const service = new TrackedMessageService();
    const message = {
      id: "message-1",
      channelId: "channel-1",
      edit: vi.fn().mockResolvedValue(undefined),
    };

    const changed = await service.handleFwaBaseSwapReaction({
      messageId: "message-1",
      reactorUserId: "reactor-1",
      message,
      render: renderFwaBaseSwapAnnouncementForTest,
    });

    expect(changed).toBe(true);
    expect(message.edit).toHaveBeenCalledTimes(1);
    const editPayload = message.edit.mock.calls[0]?.[0];
    expect(editPayload.allowedMentions.users).toEqual(["reactor-1"]);
  });

  it("keeps single-post mode when rendered content fits the Discord limit", () => {
    const plan = buildFwaBaseSwapRenderPlanForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
      ],
    });

    expect(plan.fitsSingleMessage).toBe(true);
    expect(plan.splitContents).toBeNull();
    expect(plan.singleContent.length).toBeLessThanOrEqual(2000);
    expect(plan.singleContent).toContain("React with ✅ once your base is fixed.");
  });

  it("builds deterministic two-part split plans without truncating required lines", () => {
    const oversizedEntries = Array.from({ length: 70 }, (_, index) =>
      buildEntry({
        position: index + 1,
        playerTag: `#TAG${index + 1}`,
        playerName: `Player_${index + 1}`,
        section: index % 2 === 0 ? "war_bases" : "base_errors",
        discordUserId: `${100000 + index}`,
        townhallLevel: index % 2 === 0 ? 18 : 16,
      }),
    );

    const plan = buildFwaBaseSwapRenderPlanForTest({
      entries: oversizedEntries,
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
        buildLayoutLink({
          townhall: 16,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH16%3AWB%3AAAAAAQAAAAM9F6wQbYh_86ZfK2idfKk8",
        }),
      ],
    });

    expect(plan.fitsSingleMessage).toBe(false);
    expect(plan.splitContents).not.toBeNull();
    const split = plan.splitContents as [string, string];
    expect(split[0].length).toBeLessThanOrEqual(2000);
    expect(split[1].length).toBeLessThanOrEqual(2000);
    expect(`${split[0]}\n${split[1]}`).toBe(plan.singleContent);
    expect(split[0]).not.toContain("...truncated");
    expect(split[1]).not.toContain("...truncated");
    expect(split[1]).toContain("React with ✅ once your base is fixed.");
    const lineSet = new Set(plan.singleContent.split("\n"));
    for (const line of split[0].split("\n")) {
      expect(lineSet.has(line)).toBe(true);
    }
    for (const line of split[1].split("\n")) {
      expect(lineSet.has(line)).toBe(true);
    }
  });
});

describe("FWA base-swap split-post reaction tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates shared acknowledgement state when reacting on either split message", async () => {
    const metadataPartOne: FwaBaseSwapTrackedMetadata = {
      clanName: "Test Clan",
      createdByUserId: "admin-1",
      createdAtIso: "2026-03-19T00:00:00.000Z",
      renderVariant: "split_part_1",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "reactor-1",
          acknowledged: false,
        }),
      ],
      layoutLinks: [],
    };
    const metadataPartTwo: FwaBaseSwapTrackedMetadata = {
      ...metadataPartOne,
      renderVariant: "split_part_2",
    };

    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: "row-1",
      messageId: "message-1",
      channelId: "channel-1",
      referenceId: "fwa-base-swap:key",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      metadata: metadataPartOne,
    });
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "row-1",
        messageId: "message-1",
        channelId: "channel-1",
        referenceId: "fwa-base-swap:key",
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
        metadata: metadataPartOne,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
      {
        id: "row-2",
        messageId: "message-2",
        channelId: "channel-1",
        referenceId: "fwa-base-swap:key",
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
        metadata: metadataPartTwo,
        createdAt: new Date("2026-03-19T00:00:01.000Z"),
      },
    ]);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);

    const currentMessage = {
      id: "message-1",
      channelId: "channel-1",
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const siblingMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
    };

    const service = new TrackedMessageService();
    const changed = await service.handleFwaBaseSwapReaction({
      messageId: "message-1",
      reactorUserId: "reactor-1",
      message: currentMessage,
      render: renderFwaBaseSwapAnnouncementForTest,
      resolveMessageForEdit: async ({ messageId }) =>
        messageId === "message-2" ? siblingMessage : null,
    });

    expect(changed).toBe(true);
    expect(currentMessage.edit).toHaveBeenCalledTimes(1);
    expect(siblingMessage.edit).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.trackedMessage.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { messageId: "message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            entries: [expect.objectContaining({ acknowledged: true })],
          }),
        }),
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { messageId: "message-2" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            entries: [expect.objectContaining({ acknowledged: true })],
          }),
        }),
      }),
    );
  });
});

describe("FWA base-swap split-post prompt actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes exactly two split posts when requester clicks Yes", async () => {
    const key = "split-key-yes";
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      guildId: "guild-1",
      channelId: "channel-1",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "user-1",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: ["user-1"],
      createdAtIso: "2026-03-20T00:00:00.000Z",
      splitContents: [
        "Part 1 content\nline 2",
        `Part 2 content\n\nReact with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`,
      ],
    });

    const postedA = {
      id: "msg-1",
      url: "https://discord.com/channels/guild-1/channel-1/msg-1",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const postedB = {
      id: "msg-2",
      url: "https://discord.com/channels/guild-1/channel-1/msg-2",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce(postedA)
      .mockResolvedValueOnce(postedB);

    const interaction = {
      customId: buildFwaBaseSwapSplitPostCustomId({
        userId: "user-1",
        key,
        action: "yes",
      }),
      user: {
        id: "user-1",
        send: vi.fn().mockResolvedValue(undefined),
      },
      guildId: "guild-1",
      channelId: "channel-1",
      channel: {
        isTextBased: () => true,
        send,
      },
      followUp: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleFwaBaseSwapSplitPostButton(interaction as any);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "Part 1 content\nline 2",
        allowedMentions: { users: ["user-1"] },
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: `Part 2 content\n\nReact with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`,
        allowedMentions: { users: ["user-1"] },
      }),
    );
    expect(postedA.react).toHaveBeenCalledWith(FWA_BASE_SWAP_ACK_EMOJI);
    expect(postedB.react).toHaveBeenCalledWith(FWA_BASE_SWAP_ACK_EMOJI);
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(2);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(postedA.url),
        components: [],
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("cancels split posting when requester clicks Cancel", async () => {
    const key = "split-key-cancel";
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      guildId: "guild-1",
      channelId: "channel-1",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      entries: [],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: [],
      createdAtIso: "2026-03-20T00:00:00.000Z",
      splitContents: ["part-1", "part-2"],
    });

    const interaction = {
      customId: buildFwaBaseSwapSplitPostCustomId({
        userId: "user-1",
        key,
        action: "cancel",
      }),
      user: { id: "user-1", send: vi.fn() },
      guildId: "guild-1",
      channelId: "channel-1",
      channel: {
        isTextBased: () => true,
        send: vi.fn(),
      },
      followUp: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleFwaBaseSwapSplitPostButton(interaction as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({
      content: "Cancelled. No split base-swap posts were published.",
      components: [],
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe("FWA base-swap DM copy helpers", () => {
  it("creates a single ACTIVE WAR BASE line when all pings fit", () => {
    const lines = buildFwaBaseSwapActiveWarDmLinesForTest([
      buildEntry({
        position: 1,
        playerTag: "#AAA111",
        playerName: "Alpha",
        section: "war_bases",
      }),
      buildEntry({
        position: 2,
        playerTag: "#BBB222",
        playerName: "Bravo",
        section: "war_bases",
      }),
      buildEntry({
        position: 3,
        playerTag: "#CCC333",
        playerName: "Charlie",
        section: "war_bases",
      }),
    ]);

    expect(lines).toEqual([
      "ACTIVE WAR BASE: swap to FWA now @Alpha @Bravo @Charlie",
    ]);
  });

  it("splits ACTIVE WAR BASE lines when there are more than five pings", () => {
    const lines = buildFwaBaseSwapActiveWarDmLinesForTest([
      buildEntry({
        position: 1,
        playerTag: "#A1",
        playerName: "One",
        section: "war_bases",
      }),
      buildEntry({
        position: 2,
        playerTag: "#A2",
        playerName: "Two",
        section: "war_bases",
      }),
      buildEntry({
        position: 3,
        playerTag: "#A3",
        playerName: "Three",
        section: "war_bases",
      }),
      buildEntry({
        position: 4,
        playerTag: "#A4",
        playerName: "Four",
        section: "war_bases",
      }),
      buildEntry({
        position: 5,
        playerTag: "#A5",
        playerName: "Five",
        section: "war_bases",
      }),
      buildEntry({
        position: 6,
        playerTag: "#A6",
        playerName: "Six",
        section: "war_bases",
      }),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "ACTIVE WAR BASE: swap to FWA now @One @Two @Three @Four @Five",
    );
    expect(lines[1]).toBe("ACTIVE WAR BASE: swap to FWA now @Six");
  });

  it("splits lines before five pings when the 256-char limit is reached", () => {
    const longTokenA = `@${"a".repeat(110)}`;
    const longTokenB = `@${"b".repeat(110)}`;
    const longTokenC = `@${"c".repeat(110)}`;
    const lines = batchFwaBaseSwapPingLinesForTest(
      "ACTIVE WAR BASE: swap to FWA now",
      [longTokenA, longTokenB, longTokenC],
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(longTokenA);
    expect(lines[0]).toContain(longTokenB);
    expect(lines[0]).not.toContain(longTokenC);
    expect(lines[1]).toContain(longTokenC);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(256);
    }
  });

  it("keeps generated lines valid at exact five pings and exact 256 chars", () => {
    const fivePingLine = batchFwaBaseSwapPingLinesForTest(
      "ACTIVE WAR BASE: swap to FWA now",
      ["@a", "@b", "@c", "@d", "@e"],
    );
    expect(fivePingLine).toEqual([
      "ACTIVE WAR BASE: swap to FWA now @a @b @c @d @e",
    ]);

    const prefix = "ACTIVE WAR BASE: swap to FWA now";
    const exactLengthToken = `@${"z".repeat(256 - prefix.length - 2)}`;
    const exactLine = batchFwaBaseSwapPingLinesForTest(prefix, [exactLengthToken]);
    expect(exactLine).toHaveLength(1);
    expect(exactLine[0].length).toBe(256);
  });

  it("groups base-error lines by TH and preserves member order inside each TH", () => {
    const lines = buildFwaBaseSwapBaseErrorDmLinesForTest([
      buildEntry({
        position: 2,
        playerTag: "#B1",
        playerName: "Two",
        section: "base_errors",
        townhallLevel: 16,
      }),
      buildEntry({
        position: 3,
        playerTag: "#B2",
        playerName: "Three",
        section: "base_errors",
        townhallLevel: 15,
      }),
      buildEntry({
        position: 4,
        playerTag: "#B3",
        playerName: "Four",
        section: "base_errors",
        townhallLevel: 16,
      }),
    ]);

    expect(lines).toEqual([
      "TH16 update FWA layout: !th16 @Two @Four",
      "TH15 update FWA layout: !th15 @Three",
    ]);
  });

  it("assembles readable DM sections and separator only when both sections exist", () => {
    const content = buildFwaBaseSwapDmContentForTest([
      buildEntry({
        position: 1,
        playerTag: "#A1",
        playerName: "Alpha",
        section: "war_bases",
      }),
      buildEntry({
        position: 2,
        playerTag: "#B1",
        playerName: "Bravo",
        section: "base_errors",
        townhallLevel: 16,
      }),
    ]);

    expect(content).toContain("Active war base messages:");
    expect(content).toContain("Base error messages:");
    expect(content).toContain("----------");
    expect(content).toContain(
      "`ACTIVE WAR BASE: swap to FWA now @Alpha`",
    );
    expect(content).toContain(
      "`TH16 update FWA layout: !th16 @Bravo`",
    );
  });

  it("omits empty sections and returns null when there are no players in either category", () => {
    const onlyActive = buildFwaBaseSwapDmContentForTest([
      buildEntry({
        position: 1,
        playerTag: "#A1",
        playerName: "Alpha",
        section: "war_bases",
      }),
    ]);
    expect(onlyActive).toContain("Active war base messages:");
    expect(onlyActive).not.toContain("Base error messages:");
    expect(onlyActive).not.toContain("----------");

    const none = buildFwaBaseSwapDmContentForTest([]);
    expect(none).toBeNull();
  });

  it("wraps each generated copy line in inline backticks without changing line constraints", () => {
    const content = buildFwaBaseSwapDmContentForTest([
      buildEntry({
        position: 1,
        playerTag: "#A1",
        playerName: "Alpha",
        section: "war_bases",
      }),
      buildEntry({
        position: 2,
        playerTag: "#A2",
        playerName: "Beta",
        section: "war_bases",
      }),
    ]);
    expect(content).not.toBeNull();
    const lines = String(content).split("\n");
    const wrappedLines = lines.filter((line) => line.startsWith("`"));
    expect(wrappedLines.length).toBeGreaterThan(0);
    for (const wrappedLine of wrappedLines) {
      expect(wrappedLine.endsWith("`")).toBe(true);
      const raw = wrappedLine.slice(1, -1);
      expect(raw.includes("\n")).toBe(false);
      expect(raw.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("FWA base-swap DM delivery behavior", () => {
  it("completes normally when DM delivery succeeds", async () => {
    const sendDm = vi.fn().mockResolvedValue(undefined);
    const sendFailureNotice = vi.fn().mockResolvedValue(undefined);

    const result = await deliverFwaBaseSwapDmMessagesForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#A1",
          playerName: "Alpha",
          section: "war_bases",
        }),
      ],
      guildId: "guild-1",
      channelId: "channel-1",
      clanTag: "2QG2C08UP",
      userId: "user-1",
      sendDm,
      sendFailureNotice,
    });

    expect(result).toBe("sent");
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(sendFailureNotice).not.toHaveBeenCalled();
  });

  it("keeps command flow successful and sends failure notice when DM fails", async () => {
    const sendDm = vi.fn().mockRejectedValue(new Error("dm blocked"));
    const sendFailureNotice = vi.fn().mockResolvedValue(undefined);

    const result = await deliverFwaBaseSwapDmMessagesForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#A1",
          playerName: "Alpha",
          section: "war_bases",
        }),
      ],
      guildId: "guild-1",
      channelId: "channel-1",
      clanTag: "2QG2C08UP",
      userId: "user-1",
      sendDm,
      sendFailureNotice,
    });

    expect(result).toBe("failed_notified");
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(sendFailureNotice).toHaveBeenCalledTimes(1);
    expect(sendFailureNotice).toHaveBeenCalledWith(
      "Posted the base-swap message, but I couldn't DM you the in-game ping messages.",
    );
  });
});
