import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  fwaLayouts: {
    findMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  trackedMessage: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  trackedMessageClaim: {
    findFirst: vi.fn(),
    createMany: vi.fn(),
  },
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        trackedMessage: prismaMock.trackedMessage,
        trackedMessageClaim: prismaMock.trackedMessageClaim,
      });
    }
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return null;
  }),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

const baseSwapRosterMock = vi.hoisted(() => ({
  resolveBaseSwapRosterForClan: vi.fn(),
}));

vi.mock("../src/services/BaseSwapRosterService", () => ({
  buildBaseSwapClanAutocompleteChoices: vi.fn(),
  resolveBaseSwapRosterForClan: baseSwapRosterMock.resolveBaseSwapRosterForClan,
}));

const emojiResolverMock = vi.hoisted(() => ({
  fetchApplicationEmojiInventory: vi.fn(),
}));

vi.mock("../src/services/emoji/EmojiResolverService", () => ({
  emojiResolverService: emojiResolverMock,
}));

import {
  batchFwaBaseSwapPingLinesForTest,
  buildFwaBaseSwapActiveWarDmLinesForTest,
  buildFwaBaseSwapAuditLogContentForTest,
  buildFwaBaseSwapAnnouncementEntriesForTest,
  buildFwaBaseSwapBaseErrorDmLinesForTest,
  buildFwaBaseSwapCommandTextForTest,
  buildFwaBaseSwapDmContentForTest,
  buildFwaBaseSwapFwaBaseDmLinesForTest,
  buildFwaBaseSwapRenderPlanForTest,
  buildBaseSwapAnnouncementEntriesForTest,
  clearFwaBaseSwapSplitPostPayloadsForTest,
  deliverFwaBaseSwapDmMessagesForTest,
  FWA_BASE_SWAP_ACK_EMOJI,
  FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI,
  FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI,
  buildFwaBaseSwapPhaseTimingLineForTest,
  parseFwaBaseSwapPositionSelectionsForTest,
  logFwaBaseSwapPublicationForTest,
  handleFwaBaseSwapSplitPostButton,
  Fwa,
  renderFwaBaseSwapAnnouncementForTest,
  setFwaBaseSwapSplitPostPayloadForTest,
  validateFwaBaseSwapSwapReminderOptionForTest,
} from "../src/commands/Fwa";
import { buildFwaBaseSwapSplitPostCustomId } from "../src/commands/fwa/customIds";
import { BotLogChannelService } from "../src/services/BotLogChannelService";
import {
  FwaBaseSwapTrackedMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
  TrackedMessageService,
} from "../src/services/TrackedMessageService";
import { repWorkActivityService } from "../src/services/RepWorkActivityService";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(BotLogChannelService.prototype, "getChannelIdForType").mockResolvedValue(
    null,
  );
  vi.spyOn(BotLogChannelService.prototype, "getBaseSwapRoutingConfig").mockResolvedValue(
    null,
  );
  clearFwaBaseSwapSplitPostPayloadsForTest();
  prismaMock.clanPointsSync.findFirst.mockReset();
  prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
  prismaMock.$queryRaw.mockReset();
  prismaMock.fwaLayouts.findMany.mockReset();
  prismaMock.trackedMessage.findUnique.mockReset();
  prismaMock.trackedMessage.findMany.mockReset();
  prismaMock.trackedMessage.update.mockReset();
  prismaMock.trackedMessage.updateMany.mockReset();
  prismaMock.trackedMessage.upsert.mockReset();
  prismaMock.trackedMessageClaim.findFirst.mockReset();
  prismaMock.trackedMessageClaim.createMany.mockReset();
  prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        trackedMessage: prismaMock.trackedMessage,
        trackedMessageClaim: prismaMock.trackedMessageClaim,
      });
    }
    if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
    return null;
  });
  baseSwapRosterMock.resolveBaseSwapRosterForClan.mockReset();
  vi.spyOn(
    trackedMessageService,
    "resolveFwaBaseSwapSyncIdentityForClanWar",
  ).mockResolvedValue({
    syncMessageId: null,
    source: "none",
  });
  emojiResolverMock.fetchApplicationEmojiInventory.mockReset();
  emojiResolverMock.fetchApplicationEmojiInventory.mockResolvedValue({
    ok: false,
    code: "application_missing",
    diagnostics: {
      applicationExistedBeforeFetch: false,
      applicationFetchAttempted: false,
      applicationEmojiFetchAvailable: false,
      emojiFetchSucceeded: false,
      fetchedEmojiCount: 0,
    },
  });
});

function buildEntry(input: {
  position: number;
  playerTag: string;
  playerName: string;
  section: "war_bases" | "base_errors" | "fwa_bases";
  discordUserId?: string | null;
  townhallLevel?: number | null;
  acknowledged?: boolean;
  baseErrorNote?: string | null;
}): FwaBaseSwapTrackedMetadata["entries"][number] {
  return {
    position: input.position,
    playerTag: input.playerTag,
    playerName: input.playerName,
    discordUserId: input.discordUserId ?? null,
    townhallLevel: input.townhallLevel ?? null,
    section: input.section,
    acknowledged: input.acknowledged ?? false,
    ...(input.baseErrorNote !== undefined ? { baseErrorNote: input.baseErrorNote } : {}),
  };
}

function buildLayoutLink(input: { townhall: number; layoutLink: string }) {
  return {
    townhall: input.townhall,
    layoutLink: input.layoutLink,
  };
}

function buildRosterMember(input: {
  position: number;
  playerTag: string;
  playerName: string;
  section: "war_bases" | "base_errors" | "fwa_bases";
  discordUserId?: string | null;
  townhallLevel?: number | null;
}) {
  return {
    position: input.position,
    playerTag: input.playerTag,
    playerName: input.playerName,
    townhallLevel: input.townhallLevel ?? null,
    discordUserId: input.discordUserId ?? null,
    section: input.section,
  };
}

function makeBaseSwapCommandInteraction(input: {
  clanTag: string;
  warBases?: string | null;
  baseErrors?: string | null;
  fwaBases?: string | null;
  swapReminder?: boolean | null;
  pingRoleId?: string | null;
  guildId?: string;
  invokeChannelId?: string;
  mailChannelId?: string | null;
  botLogChannelId?: string | null;
  userId?: string;
  username?: string;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const interactionChannelSend = vi.fn().mockResolvedValue(undefined);
  const mailChannelSend = vi.fn();
  const botLogSend = vi.fn().mockResolvedValue(undefined);
  const customLogChannelSend = vi.fn().mockResolvedValue(undefined);
  const mailChannel =
    input.mailChannelId === null
      ? null
      : {
          id: input.mailChannelId ?? "mail-1",
          guildId: input.guildId ?? "guild-1",
          isTextBased: () => true,
          send: mailChannelSend,
        };
  const botLogChannel =
    input.botLogChannelId === null
      ? null
      : {
          id: input.botLogChannelId ?? "bot-log-1",
          guildId: input.guildId ?? "guild-1",
          isTextBased: () => true,
          send: botLogSend,
        };

  const client = {
    channels: {
      fetch: vi.fn().mockImplementation(async (channelId: string) => {
        if (channelId === input.mailChannelId) return mailChannel;
        if (channelId === input.botLogChannelId) return botLogChannel;
        return null;
      }),
    },
  } as any;

  const interaction = {
    id: "interaction-1",
    guildId: input.guildId ?? "guild-1",
    channelId: input.invokeChannelId ?? "invoke-channel-1",
    client,
    user: {
      id: input.userId ?? "user-1",
      username: input.username ?? "Requester",
      send: vi.fn().mockResolvedValue(undefined),
    },
    channel: {
      id: input.invokeChannelId ?? "invoke-channel-1",
      guildId: input.guildId ?? "guild-1",
      isTextBased: () => true,
      send: interactionChannelSend,
    },
    inGuild: vi.fn(() => true),
    deferReply,
    editReply,
    followUp,
    reply,
    update,
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => "base-swap"),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clanTag;
        if (name === "war-bases") return input.warBases ?? null;
        if (name === "base-errors") return input.baseErrors ?? null;
        if (name === "fwa-bases") return input.fwaBases ?? null;
        if (name === "visibility") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "swap-reminder") return input.swapReminder ?? null;
        return null;
      }),
      getRole: vi.fn((name: string) => {
        if (name === "ping_role" && input.pingRoleId) {
          return { id: input.pingRoleId } as any;
        }
        return null;
      }),
      getChannel: vi.fn(() => null),
    },
  };

  return {
    interaction,
    client,
    deferReply,
    editReply,
    followUp,
    reply,
    update,
    interactionChannelSend,
    mailChannelSend,
    botLogSend,
    customLogChannelSend,
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

    const th18Line = `${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>`;
    const th17Line = `${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH17: <https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AAAAARQAAAAI6ppxkTfH3WnNJjWK96bqn>`;
    const reactLine = `👇 React with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`;

    const th18Index = content.indexOf(th18Line);
    const th17Index = content.indexOf(th17Line);
    const reactIndex = content.indexOf(reactLine);
    const playerLineIndex = content.indexOf("#2 - *(unlinked)* - Bravo - :x:");
    const lines = content.split("\n");
    const th17LineIndex = lines.lastIndexOf(th17Line);

    expect(th18Index).toBeGreaterThan(-1);
    expect(th17Index).toBeGreaterThan(-1);
    expect(th18Index).toBeLessThan(th17Index);
    expect(playerLineIndex).toBeGreaterThan(-1);
    expect(th18Index).toBeGreaterThan(playerLineIndex);
    expect(reactIndex).toBeGreaterThan(th17Index);
    expect(lines[th17LineIndex + 2]).toBe(reactLine);
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
      "<a:arrow_arrow:10002> TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>",
    );
    expect(content).not.toContain("## <a:arrow_arrow:10002> TH18:");
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
      `${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>`,
    );
    expect(content).not.toContain(`## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18:`);
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

  it("filters fwa-bases from layout links while keeping war-bases links", () => {
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
          section: "fwa_bases",
          townhallLevel: 17,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
        buildLayoutLink({
          townhall: 17,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AAAAARQAAAAI6ppxkTfH3WnNJjWK96bqn",
        }),
      ],
    });

    expect(content).toContain("TH18:");
    expect(content).not.toContain("TH17:");
  });

  it("filters fwa-bases from layout links while keeping base-errors links", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          townhallLevel: 18,
        }),
        buildEntry({
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "fwa_bases",
          townhallLevel: 17,
        }),
      ],
      layoutLinks: [
        buildLayoutLink({
          townhall: 18,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg",
        }),
        buildLayoutLink({
          townhall: 17,
          layoutLink:
            "https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AAAAARQAAAAI6ppxkTfH3WnNJjWK96bqn",
        }),
      ],
    });

    expect(content).toContain("TH18:");
    expect(content).not.toContain("TH17:");
  });

  it("parses comma-separated, space-separated, and mixed-separated position lists for all base-swap args", () => {
    const cases = [
      { label: "war-bases", section: "war_bases" as const },
      { label: "base-errors", section: "base_errors" as const },
      { label: "fwa-bases", section: "fwa_bases" as const },
    ];
    const raws = ["1,2,3", "1 2 3", "1, 2 3"];

    for (const { label, section } of cases) {
      for (const raw of raws) {
        const parsed = parseFwaBaseSwapPositionSelectionsForTest({
          selections: [
            {
              label,
              section,
              raw,
            },
          ],
        });

        expect(parsed).toEqual({
          ok: true,
          selections: [
            {
              label,
              section,
              positions: [1, 2, 3],
            },
          ],
        });
      }
    }
  });

  it("parses grouped base-error explanations and preserves shared notes", () => {
    const mixed = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: "1 4 5 12, 15 builder not separated by 6 spaces, 19 revenge tower not in corner, 23 26, 32 firespitters facing wrong direction, 43",
        },
      ],
    });

    expect(mixed).toEqual({
      ok: true,
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          positions: [1, 4, 5, 12, 15, 19, 23, 26, 32, 43],
          baseErrorNotes: [
            { position: 15, note: "builder not separated by 6 spaces" },
            { position: 19, note: "revenge tower not in corner" },
            { position: 32, note: "firespitters facing wrong direction" },
          ],
        },
      ],
    });

    const shared = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: "23 26 firespitters facing wrong direction",
        },
      ],
    });

    expect(shared).toEqual({
      ok: true,
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          positions: [23, 26],
          baseErrorNotes: [
            { position: 23, note: "firespitters facing wrong direction" },
            { position: 26, note: "firespitters facing wrong direction" },
          ],
        },
      ],
    });
  });

  it("rejects malformed numeric base-error tokens before note text starts", () => {
    for (const [raw, token] of [
      ["1 0", "0"],
      ["1 -2", "-2"],
      ["1 2.5", "2.5"],
      ["1 +2", "+2"],
      ["1 1e3", "1e3"],
    ] as const) {
      const result = parseFwaBaseSwapPositionSelectionsForTest({
        selections: [
          {
            label: "base-errors",
            section: "base_errors",
            raw,
          },
        ],
      });

      expect(result).toEqual({
        ok: false,
        error:
          `Invalid \`base-errors\` position token \`${token}\` in \`${raw}\`: use unsigned positive roster positions before any explanation text.`,
      });
    }
  });

  it("keeps a single note-bearing base-error group valid and preserves its text", () => {
    const result = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: "15 builder not separated by 6 spaces",
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          positions: [15],
          baseErrorNotes: [
            {
              position: 15,
              note: "builder not separated by 6 spaces",
            },
          ],
        },
      ],
    });
  });

  it("rejects text-only base-error groups, note overflows, and text in the numeric args", () => {
    const textOnly = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: "builder not separated by 6 spaces",
        },
      ],
    });
    expect(textOnly).toEqual({
      ok: false,
      error:
        "Invalid `base-errors` group `builder not separated by 6 spaces`: each group must begin with one or more positive roster positions.",
    });

    const tooLong = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: `1 ${"a".repeat(161)}`,
        },
      ],
    });
    expect(tooLong).toEqual({
      ok: false,
      error:
        `Base-error explanation for \`1 ${"a".repeat(161)}\` is too long. Keep each note to 160 characters or fewer.`,
    });

    for (const label of ["war-bases", "fwa-bases"] as const) {
      const invalid = parseFwaBaseSwapPositionSelectionsForTest({
        selections: [
          {
            label,
            section: label === "war-bases" ? "war_bases" : "fwa_bases",
            raw: "1,abc",
          },
        ],
      });
      expect(invalid).toEqual({
        ok: false,
        error:
          `Explanations are supported only in \`base-errors\`; \`${label}\` accepts positions only. Use comma-separated or space-separated positive roster positions like \`1, 4, 7\`.`,
      });
    }
  });

  it("rejects duplicate positions across separate base-error groups", () => {
    const duplicate = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: "1, 1 builder not separated by 6 spaces",
        },
      ],
    });

    expect(duplicate).toEqual({
      ok: false,
      error: "Duplicate positions in `base-errors`: #1.",
    });
  });

  it("allows war-bases and base-errors to share a position", () => {
    const overlap = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "war-bases",
          section: "war_bases",
          raw: "1",
        },
        {
          label: "base-errors",
          section: "base_errors",
          raw: "1",
        },
      ],
    });

    expect(overlap).toEqual({
      ok: true,
      selections: [
        {
          label: "war-bases",
          section: "war_bases",
          positions: [1],
        },
        {
          label: "base-errors",
          section: "base_errors",
          positions: [1],
        },
      ],
    });
  });

  it("renders the same position in both existing sections when war-bases overlaps base-errors", () => {
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
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
    });

    expect(content).toContain("YOU HAVE AN ACTIVE WAR BASE");
    expect(content).toContain("YOU HAVE BASE ERRORS");
    expect((content.match(/#1 - <@100> - Alpha - :x:/g) ?? []).length).toBe(2);
  });

  it("renders base-error notes inline and preserves them across acknowledgement rerenders", () => {
    const note = "builder not separated by 6 spaces";
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 15,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          discordUserId: "100",
          townhallLevel: 18,
          baseErrorNote: note,
        }),
        buildEntry({
          position: 16,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "war_bases",
          discordUserId: "101",
          townhallLevel: 17,
        }),
      ],
      layoutLinks: [],
    });

    expect(content).toContain(
      `#15 - <@100> - Alpha - :x: — ${note}`,
    );
    expect(content).toContain("#16 - <@101> - Bravo - :x:");
    expect(content).not.toContain(
      "#16 - <@101> - Bravo - :x: —",
    );

    const acknowledged = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 15,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          discordUserId: "100",
          townhallLevel: 18,
          acknowledged: true,
          baseErrorNote: note,
        }),
      ],
      layoutLinks: [],
    });

    expect(acknowledged).toContain(
      `#15 - <@100> - Alpha - ${FWA_BASE_SWAP_ACK_EMOJI} — ${note}`,
    );
    expect(acknowledged).toContain(note);
    expect(acknowledged).not.toContain(":x: —");
  });

  it("attaches base-error notes only to base-errors entries during announcement construction", () => {
    const result = buildBaseSwapAnnouncementEntriesForTest({
      clanKind: "FWA",
      clanTag: "2QG2C08UP",
      roster: [
        buildRosterMember({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      selections: [
        {
          label: "war-bases",
          section: "war_bases",
          positions: [1],
        },
        {
          label: "base-errors",
          section: "base_errors",
          positions: [1],
          baseErrorNotes: [
            { position: 1, note: "builder not separated by 6 spaces" },
          ],
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      entries: [
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          discordUserId: "100",
          townhallLevel: 18,
          section: "war_bases",
          acknowledged: false,
          baseErrorNote: null,
        },
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          discordUserId: "100",
          townhallLevel: 18,
          section: "base_errors",
          acknowledged: false,
          baseErrorNote: "builder not separated by 6 spaces",
        },
      ],
    });
  });

  it("rejects fwa-bases overlap with war-bases and base-errors", () => {
    const warOverlap = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "war-bases",
          section: "war_bases",
          raw: "1,2",
        },
        {
          label: "fwa-bases",
          section: "fwa_bases",
          raw: "2,3",
        },
      ],
    });
    expect(warOverlap).toEqual({
      ok: false,
      error:
        "Positions cannot appear in both `war-bases` and `fwa-bases`: #2.",
    });

    const baseErrorOverlap = parseFwaBaseSwapPositionSelectionsForTest({
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          raw: "3,4",
        },
        {
          label: "fwa-bases",
          section: "fwa_bases",
          raw: "4,5",
        },
      ],
    });
    expect(baseErrorOverlap).toEqual({
      ok: false,
      error:
        "Positions cannot appear in both `base-errors` and `fwa-bases`: #4.",
    });
  });

  it("allows swap-reminder when any base-swap section is present", () => {
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        warBasesRaw: "1",
        baseErrorsRaw: null,
        fwaBasesRaw: null,
        swapReminderRaw: true,
      }),
    ).toBeNull();
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        warBasesRaw: null,
        baseErrorsRaw: "2",
        fwaBasesRaw: null,
        swapReminderRaw: false,
      }),
    ).toBeNull();
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        warBasesRaw: null,
        baseErrorsRaw: null,
        fwaBasesRaw: "1,2",
        swapReminderRaw: null,
      }),
    ).toBeNull();
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        warBasesRaw: null,
        baseErrorsRaw: null,
        fwaBasesRaw: null,
        swapReminderRaw: true,
      }),
    ).toBe(
      "`swap-reminder` can only be used when at least one of `war-bases`, `base-errors`, or `fwa-bases` is provided.",
    );
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        warBasesRaw: null,
        baseErrorsRaw: null,
        fwaBasesRaw: null,
        swapReminderRaw: false,
      }),
    ).toBe(
      "`swap-reminder` can only be used when at least one of `war-bases`, `base-errors`, or `fwa-bases` is provided.",
    );
  });

  it("renders the fwa-bases section and keeps the preparation and react prompt lines", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "fwa_bases",
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
      phaseTimingLine:
        "## Preparation Day ends <t:1740000000:F> (<t:1740000000:R>)",
      alertEmoji: "<a:alert:10001>",
      fwaAlertEmoji: "<a:alert_blue:10003>",
    });

    expect(content).toContain(
      "# <a:alert_blue:10003> YOU HAVE AN ACTIVE FWA BASE <a:alert_blue:10003>",
    );
    expect(content).toContain(
      "These players currently have an active FWA base. Please swap to an active war base to increase our chances of beating the blacklisted clan!",
    );
    expect(content).not.toContain("TH18:");
    expect(content).toContain("Preparation Day ends <t:1740000000:F>");
    expect(content).toContain(
      `React with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`,
    );
  });

  it("keeps the main announcement free of swap-back reminder content when swap-reminder is enabled", () => {
    const mainContent = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "fwa_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
      swapReminder: true,
      clanRoleId: "123456789012345678",
    });

    expect(mainContent).not.toContain("# Swap to WAR Bases");
    expect(mainContent).not.toContain("<@&123456789012345678>");
  });

  it("uses alert for war-bases and alert_blue for fwa-bases in mixed sections", () => {
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
          section: "fwa_bases",
          discordUserId: "101",
          townhallLevel: 17,
        }),
      ],
      layoutLinks: [],
      alertEmoji: "<a:alert:10001>",
      fwaAlertEmoji: "<a:alert_blue:10003>",
    });

    expect(content).toContain(
      "# <a:alert:10001> YOU HAVE AN ACTIVE WAR BASE <a:alert:10001>",
    );
    expect(content).toContain(
      "# <a:alert_blue:10003> YOU HAVE AN ACTIVE FWA BASE <a:alert_blue:10003>",
    );
  });

  it("falls back to the unicode alert glyph for fwa-bases when alert_blue is unavailable", () => {
    const content = renderFwaBaseSwapAnnouncementForTest({
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "fwa_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
    });

    expect(content).toContain(
      `# ${FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI} YOU HAVE AN ACTIVE FWA BASE ${FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI}`,
    );
  });

  it("updates base-error rows from :x: to the acknowledged mark on reaction", async () => {
    const note = "builder not separated by 6 spaces";
    const metadata: FwaBaseSwapTrackedMetadata = {
      clanName: "Test Clan",
      createdByUserId: "admin-1",
      createdAtIso: "2026-03-19T00:00:00.000Z",
      swapReminder: false,
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          discordUserId: "reactor-1",
          acknowledged: false,
          baseErrorNote: note,
        }),
      ],
      layoutLinks: [],
    };

    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: 42,
      messageId: "message-2",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      metadata,
    });
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);

    const service = new TrackedMessageService();
    const message = {
      id: "message-2",
      channelId: "channel-1",
      edit: vi.fn().mockResolvedValue(undefined),
    };

    const changed = await service.handleFwaBaseSwapReaction({
      messageId: "message-2",
      reactorUserId: "reactor-1",
      message,
      render: renderFwaBaseSwapAnnouncementForTest,
    });

    expect(changed).toBe(true);
    expect(message.edit).toHaveBeenCalledTimes(1);
    const editPayload = message.edit.mock.calls[0]?.[0];
    expect(String(editPayload.content)).toContain(
      `#1 - <@reactor-1> - Alpha -`,
    );
    expect(String(editPayload.content)).toContain(FWA_BASE_SWAP_ACK_EMOJI);
    expect(String(editPayload.content)).toContain(`— ${note}`);
    expect(String(editPayload.content)).not.toContain(":x:");
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            entries: [
              expect.objectContaining({
                acknowledged: true,
                baseErrorNote: note,
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("preserves TH links during tracked-message reaction re-renders", async () => {
    const metadata: FwaBaseSwapTrackedMetadata = {
      clanName: "Test Clan",
      createdByUserId: "admin-1",
      createdAtIso: "2026-03-19T00:00:00.000Z",
      swapReminder: false,
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
      "<a:arrow_arrow:10002> TH18: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>"
    );
    expect(String(editPayload.content)).not.toContain("## <a:arrow_arrow:10002> TH18:");
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
      swapReminder: false,
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

  it("keeps rerenders on the main announcement without re-allowing role pings", async () => {
    const metadata: FwaBaseSwapTrackedMetadata = {
      clanName: "Test Clan",
      createdByUserId: "admin-1",
      createdAtIso: "2026-03-19T00:00:00.000Z",
      clanRoleId: "123456789012345678",
      swapReminder: true,
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "fwa_bases",
          discordUserId: "reactor-1",
          acknowledged: false,
        }),
      ],
      layoutLinks: [],
    };

    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: 42,
      messageId: "message-3",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      metadata,
    });
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);

    const service = new TrackedMessageService();
    const message = {
      id: "message-3",
      channelId: "channel-1",
      edit: vi.fn().mockResolvedValue(undefined),
    };

    const changed = await service.handleFwaBaseSwapReaction({
      messageId: "message-3",
      reactorUserId: "reactor-1",
      message,
      render: renderFwaBaseSwapAnnouncementForTest,
    });

    expect(changed).toBe(true);
    expect(message.edit).toHaveBeenCalledTimes(1);
    const editPayload = message.edit.mock.calls[0]?.[0];
    expect(String(editPayload.content)).not.toContain("# Swap to WAR Bases");
    expect(String(editPayload.content)).not.toContain("<@&123456789012345678>");
    expect(editPayload.allowedMentions.users).toEqual(["reactor-1"]);
    expect(editPayload.allowedMentions.roles).toBeUndefined();
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

  it("builds deterministic two-part split plans without truncating note-bearing required lines", () => {
    const oversizedEntries = Array.from({ length: 70 }, (_, index) =>
      buildEntry({
        position: index + 1,
        playerTag: `#TAG${index + 1}`,
        playerName: `Player_${index + 1}`,
        section: index % 2 === 0 ? "war_bases" : "base_errors",
        discordUserId: `${100000 + index}`,
        townhallLevel: index % 2 === 0 ? 18 : 16,
        baseErrorNote:
          index === 1 ? "builder not separated by 6 spaces" : undefined,
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
    expect(plan.singleContent).toContain("builder not separated by 6 spaces");
    expect(
      split[0].includes("builder not separated by 6 spaces") ||
        split[1].includes("builder not separated by 6 spaces"),
    ).toBe(true);
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
      swapReminder: false,
      renderVariant: "split_part_1",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          discordUserId: "reactor-1",
          acknowledged: false,
          baseErrorNote: "builder not separated by 6 spaces",
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
            entries: [
              expect.objectContaining({
                acknowledged: true,
                baseErrorNote: "builder not separated by 6 spaces",
              }),
            ],
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
            entries: [
              expect.objectContaining({
                acknowledged: true,
                baseErrorNote: "builder not separated by 6 spaces",
              }),
            ],
          }),
        }),
      }),
    );
  });
});

describe("FWA base-swap reminder selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects the newest qualifying reminder candidate with fwa-bases and swap-reminder enabled", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "row-newer-skip",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-2",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "2QG2C08UP",
        createdAt: new Date("2026-03-20T00:10:00.000Z"),
        expiresAt: new Date("2026-03-22T00:00:00.000Z"),
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:10:00.000Z",
          swapReminder: true,
          entries: [
            buildEntry({
              position: 2,
              playerTag: "#BBB222",
              playerName: "Bravo",
              section: "war_bases",
              discordUserId: "user-2",
            }),
          ],
          layoutLinks: [],
        },
      },
      {
        id: "row-older-qualifying",
        guildId: "guild-1",
        channelId: "channel-2",
        messageId: "message-1",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "2QG2C08UP",
        createdAt: new Date("2026-03-20T00:05:00.000Z"),
        expiresAt: new Date("2026-03-22T00:00:00.000Z"),
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          swapReminder: true,
          entries: [
            buildEntry({
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              section: "fwa_bases",
              discordUserId: "user-1",
            }),
          ],
          layoutLinks: [],
        },
      },
      {
        id: "row-old-skip",
        guildId: "guild-1",
        channelId: "channel-3",
        messageId: "message-3",
        referenceId: null,
        clanTag: "2QG2C08UP",
        createdAt: new Date("2026-03-20T00:01:00.000Z"),
        expiresAt: new Date("2026-03-22T00:00:00.000Z"),
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:01:00.000Z",
          swapReminder: false,
          entries: [
            buildEntry({
              position: 3,
              playerTag: "#CCC333",
              playerName: "Charlie",
              section: "fwa_bases",
              discordUserId: "user-3",
            }),
          ],
          layoutLinks: [],
        },
      },
    ]);

    const service = new TrackedMessageService();
    const candidate = await service.findLatestActiveFwaBaseSwapReminderCandidate({
      guildId: "guild-1",
      clanTag: "2QG2C08UP",
    });

    expect(candidate?.messageId).toBe("message-1");
    expect(candidate?.referenceId).toBe("fwa-base-swap:split-key");
    expect(candidate?.metadata.swapReminder).toBe(true);
    expect(candidate?.metadata.entries.some((entry) => entry.section === "fwa_bases")).toBe(true);
  });

  it("claims a reminder once per reference id across split rows", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-new",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-new",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "2QG2C08UP",
        createdAt: new Date("2026-03-20T00:10:00.000Z"),
        expiresAt: new Date("2026-03-22T00:00:00.000Z"),
      },
      {
        id: "tracked-old",
        guildId: "guild-1",
        channelId: "channel-2",
        messageId: "message-old",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "2QG2C08UP",
        createdAt: new Date("2026-03-20T00:05:00.000Z"),
        expiresAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedMessageClaim.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "claim-1",
      });
    prismaMock.trackedMessageClaim.createMany.mockResolvedValue({ count: 1 });

    const service = new TrackedMessageService();
    const first = await service.claimFwaBaseSwapBattleDayReminder({
      guildId: "guild-1",
      clanTag: "2QG2C08UP",
      referenceId: "fwa-base-swap:split-key",
    });
    const second = await service.claimFwaBaseSwapBattleDayReminder({
      guildId: "guild-1",
      clanTag: "2QG2C08UP",
      referenceId: "fwa-base-swap:split-key",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(prismaMock.trackedMessageClaim.createMany).toHaveBeenCalledTimes(1);
  });
});

describe("FWA base-swap split-post prompt actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes exactly two split posts when requester clicks Yes", async () => {
    const key = "split-key-yes";
    const clanLeadSend = vi.fn().mockResolvedValue(undefined);
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      username: "Requester",
      guildId: "guild-1",
      channelId: "channel-1",
      mailChannelId: "mail-1",
      clanRoleId: null,
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: null,
        fwaBases: null,
        baseErrors: "1 builder not separated by 6 spaces",
        swapReminder: null,
      }),
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "base_errors",
          discordUserId: "user-1",
          townhallLevel: 18,
          baseErrorNote: "builder not separated by 6 spaces",
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: ["user-1"],
      swapReminder: false,
      createdAtIso: "2026-03-20T00:00:00.000Z",
      syncMessageId: "sync-message-1",
      splitContents: [
        "Part 1 content\nline 2",
        `Part 2 content\n\nReact with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`,
      ],
    });
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CLAN_LEAD",
      channelId: null,
      legacy: false,
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
        logChannelId: null,
        leaderChannelId: "223456789012345678",
      },
    ]);

    const postedA = {
      id: "msg-1",
      url: "https://discord.com/channels/guild-1/mail-1/msg-1",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const postedB = {
      id: "msg-2",
      url: "https://discord.com/channels/guild-1/mail-1/msg-2",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const mailChannelSend = vi
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
        username: "Requester",
        send: vi.fn().mockResolvedValue(undefined),
      },
      guildId: "guild-1",
      channelId: "channel-1",
      client: {
        channels: {
          fetch: vi.fn().mockImplementation(async (channelId: string) => {
            if (channelId === "mail-1") {
              return {
                guildId: "guild-1",
                isTextBased: () => true,
                send: mailChannelSend,
              };
            }
            if (channelId === "223456789012345678") {
              return {
                guildId: "guild-1",
                isTextBased: () => true,
                send: clanLeadSend,
              };
            }
            return null;
          }),
        },
      },
      channel: {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(undefined),
      },
      followUp: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleFwaBaseSwapSplitPostButton(interaction as any);

    expect(mailChannelSend).toHaveBeenCalledTimes(2);
    expect(mailChannelSend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "Part 1 content\nline 2",
        allowedMentions: { users: ["user-1"] },
      }),
    );
    expect(mailChannelSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: `Part 2 content\n\nReact with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`,
        allowedMentions: { users: ["user-1"] },
      }),
    );
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(postedA.react).toHaveBeenCalledWith(FWA_BASE_SWAP_ACK_EMOJI);
    expect(postedB.react).toHaveBeenCalledWith(FWA_BASE_SWAP_ACK_EMOJI);
    expect(clanLeadSend).toHaveBeenCalledTimes(1);
    expect(String(clanLeadSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Test Clan (#2QG2C08UP)",
    );
    expect(String(clanLeadSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "Source channel:",
    );
    expect(String(clanLeadSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      postedA.url,
    );
    expect(String(clanLeadSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      postedB.url,
    );
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.trackedMessage.upsert.mock.calls) {
      expect(call[0].create.metadata.entries).toEqual([
        expect.objectContaining({
          section: "base_errors",
          baseErrorNote: "builder not separated by 6 spaces",
        }),
      ]);
      expect(call[0].update.metadata.entries).toEqual([
        expect.objectContaining({
          section: "base_errors",
          baseErrorNote: "builder not separated by 6 spaces",
        }),
      ]);
    }
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
      username: "Requester",
      guildId: "guild-1",
      channelId: "channel-1",
      mailChannelId: "mail-1",
      clanRoleId: null,
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: null,
        fwaBases: null,
        baseErrors: null,
        swapReminder: null,
      }),
      entries: [],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: [],
      swapReminder: false,
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
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
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

describe("FWA base-swap mail-channel routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts a single base-swap announcement to the clan mail channel", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      baseErrors: "1 builder not separated by 6 spaces",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: 16,
            discordUserId: "111",
            section: "base_errors",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
      },
    ]);
    prismaMock.fwaLayouts.findMany.mockResolvedValue([
      {
        Townhall: 16,
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH16%3AWB%3AAAAAAQAAAAM9F6wQbYh_86ZfK2idfKk8",
      },
    ]);
    vi.mocked(
      trackedMessageService.resolveFwaBaseSwapSyncIdentityForClanWar,
    ).mockResolvedValueOnce({
      syncMessageId: "sync-message-1",
      source: "expired_sync_post_fallback",
    } as any);
    const recordBasesChecked = vi
      .spyOn(repWorkActivityService, "recordBasesChecked")
      .mockResolvedValue(true);
    const posted = {
      id: "msg-1",
      url: "https://discord.com/channels/guild-1/mail-1/msg-1",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    const botLogSendSpy = vi.spyOn(
      BotLogChannelService.prototype,
      "getChannelId",
    );
    botLogSendSpy.mockResolvedValue("bot-log-1");

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(run.interaction.channel.send).not.toHaveBeenCalled();
    expect(run.mailChannelSend).toHaveBeenCalledTimes(1);
    expect(run.mailChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.any(String),
        allowedMentions: { users: ["111"] },
      }),
    );
    expect(run.client.channels.fetch).toHaveBeenCalledWith("mail-1");
    expect(run.client.channels.fetch).toHaveBeenCalledWith("bot-log-1");
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = prismaMock.trackedMessage.upsert.mock.calls[0]?.[0];
    expect(upsertCall.create.channelId).toBe("mail-1");
    expect(upsertCall.update.channelId).toBe("mail-1");
    expect(String(run.mailChannelSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "builder not separated by 6 spaces",
    );
    expect(upsertCall.create.metadata.entries).toEqual([
      expect.objectContaining({
        section: "base_errors",
        baseErrorNote: "builder not separated by 6 spaces",
      }),
    ]);
    expect(upsertCall.update.metadata.entries).toEqual([
      expect.objectContaining({
        section: "base_errors",
        baseErrorNote: "builder not separated by 6 spaces",
      }),
    ]);
    expect(upsertCall.create.metadata.syncMessageId).toBe("sync-message-1");
    expect(upsertCall.update.metadata.syncMessageId).toBe("sync-message-1");
    expect(recordBasesChecked).toHaveBeenCalledTimes(1);
    expect(botLogSendSpy).toHaveBeenCalledTimes(1);
    expect(String(run.botLogSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "Source channel:",
    );
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(posted.url),
      }),
    );
  });

  it("skips audit log delivery when persisted base-swap routing is disabled", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "DISABLED",
      channelId: null,
      legacy: false,
    });
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
        logChannelId: "123456789012345678",
        leaderChannelId: "223456789012345678",
      },
    ]);
    const posted = {
      id: "msg-no-log",
      url: "https://discord.com/channels/guild-1/mail-1/msg-no-log",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.mailChannelSend).toHaveBeenCalledTimes(1);
    expect(run.botLogSend).not.toHaveBeenCalled();
    expect(run.client.channels.fetch).not.toHaveBeenCalledWith("bot-log-1");
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(posted.url),
      }),
    );
  });

  it("sends the audit log to the tracked clan log channel when persisted routing requests it", async () => {
    const clanLogSend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CLAN_LOG",
      channelId: null,
      legacy: false,
    });
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
        logChannelId: "123456789012345678",
        leaderChannelId: "223456789012345678",
      },
    ]);
    const posted = {
      id: "msg-clan-log",
      url: "https://discord.com/channels/guild-1/mail-1/msg-clan-log",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    run.client.channels.fetch.mockImplementation(async (channelId: string) => {
      if (channelId === "mail-1") {
        return {
          id: "mail-1",
          guildId: "guild-1",
          isTextBased: () => true,
          send: run.mailChannelSend,
        };
      }
      if (channelId === "123456789012345678") {
        return {
          id: "123456789012345678",
          guildId: "guild-1",
          isTextBased: () => true,
          send: clanLogSend,
        };
      }
      return null;
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.client.channels.fetch).toHaveBeenCalledWith("mail-1");
    expect(run.client.channels.fetch).toHaveBeenCalledWith("123456789012345678");
    expect(clanLogSend).toHaveBeenCalledTimes(1);
    expect(run.botLogSend).not.toHaveBeenCalled();
    expect(String(clanLogSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Command: `/fwa base-swap clan:2QG2C08UP war-bases:1`",
    );
    expect(String(clanLogSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "log-enable:",
    );
  });

  it("sends the audit log to the tracked clan leader channel when persisted routing requests it", async () => {
    const clanLeadSend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CLAN_LEAD",
      channelId: null,
      legacy: false,
    });
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
        logChannelId: "123456789012345678",
        leaderChannelId: "223456789012345678",
      },
    ]);
    const posted = {
      id: "msg-clan-lead",
      url: "https://discord.com/channels/guild-1/mail-1/msg-clan-lead",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    run.client.channels.fetch.mockImplementation(async (channelId: string) => {
      if (channelId === "mail-1") {
        return {
          id: "mail-1",
          guildId: "guild-1",
          isTextBased: () => true,
          send: run.mailChannelSend,
        };
      }
      if (channelId === "223456789012345678") {
        return {
          id: "223456789012345678",
          guildId: "guild-1",
          isTextBased: () => true,
          send: clanLeadSend,
        };
      }
      return null;
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.client.channels.fetch).toHaveBeenCalledWith("223456789012345678");
    expect(clanLeadSend).toHaveBeenCalledTimes(1);
    expect(String(clanLeadSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Command: `/fwa base-swap clan:2QG2C08UP war-bases:1`",
    );
    expect(String(clanLeadSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "log-enable:",
    );
  });

  it("uses the generic bot-log resolver when persisted base-swap routing selects bot-log channel", async () => {
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "BOT_LOG",
      channelId: null,
      legacy: false,
    });
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
        logChannelId: "clan-log-1",
        leaderChannelId: "clan-lead-1",
      },
    ]);
    const posted = {
      id: "msg-bot-log",
      url: "https://discord.com/channels/guild-1/mail-1/msg-bot-log",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    run.client.channels.fetch.mockImplementation(async (channelId: string) => {
      if (channelId === "mail-1") {
        return {
          id: "mail-1",
          guildId: "guild-1",
          isTextBased: () => true,
          send: run.mailChannelSend,
        };
      }
      if (channelId === "bot-log-1") {
        return {
          id: "bot-log-1",
          guildId: "guild-1",
          isTextBased: () => true,
          send: botLogSend,
        };
      }
      return null;
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.client.channels.fetch).toHaveBeenCalledWith("bot-log-1");
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(String(botLogSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Command: `/fwa base-swap clan:2QG2C08UP war-bases:1`",
    );
    expect(String(botLogSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "log-enable:",
    );
  });

  it("sends the audit log to the persisted custom channel", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "custom-log-1",
      legacy: false,
    });
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
        logChannelId: "clan-log-1",
        leaderChannelId: "clan-lead-1",
      },
    ]);
    const posted = {
      id: "msg-custom",
      url: "https://discord.com/channels/guild-1/mail-1/msg-custom",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    run.client.channels.fetch.mockImplementation(async (channelId: string) => {
      if (channelId === "mail-1") {
        return {
          id: "mail-1",
          guildId: "guild-1",
          isTextBased: () => true,
          send: run.mailChannelSend,
        };
      }
      if (channelId === "custom-log-1") {
        return {
          id: "custom-log-1",
          guildId: "guild-1",
          isTextBased: () => true,
          send: run.customLogChannelSend,
        };
      }
      return null;
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.mailChannelSend).toHaveBeenCalledTimes(1);
    expect(run.customLogChannelSend).toHaveBeenCalledTimes(1);
    expect(run.botLogSend).not.toHaveBeenCalled();
    expect(String(run.customLogChannelSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Command: `/fwa base-swap clan:2QG2C08UP war-bases:1`",
    );
    expect(String(run.customLogChannelSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "log-enable:",
    );
  });

  it("does not include the clan role allowedMention for base-errors only posts", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      baseErrors: "2",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 2,
            playerTag: "#BBB222",
            playerName: "Bravo",
            townhallLevel: null,
            discordUserId: "111",
            section: "base_errors",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: "123456789012345678",
      },
    ]);
    const posted = {
      id: "msg-2",
      url: "https://discord.com/channels/guild-1/mail-1/msg-2",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.mailChannelSend).toHaveBeenCalledTimes(1);
    expect(run.mailChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.any(String),
        allowedMentions: { users: ["111"] },
      }),
    );
    expect(String(run.mailChannelSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "<@&123456789012345678>",
    );
  });

  it("does not include the clan role allowedMention for fwa-bases main posts when swap-reminder is disabled", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      fwaBases: "1",
      swapReminder: false,
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
            section: "fwa_bases",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: "123456789012345678",
      },
    ]);
    const posted = {
      id: "msg-3",
      url: "https://discord.com/channels/guild-1/mail-1/msg-3",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.mailChannelSend).toHaveBeenCalledTimes(1);
    expect(run.mailChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.any(String),
        allowedMentions: { users: ["111"] },
      }),
    );
    expect(String(run.mailChannelSend.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "<@&123456789012345678>",
    );
  });

  it("posts only the main tracked base-swap message during command execution when swap-reminder is enabled", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      fwaBases: "1",
      swapReminder: true,
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
            section: "fwa_bases",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: "123456789012345678",
      },
    ]);
    const posted = {
      id: "msg-1",
      url: "https://discord.com/channels/guild-1/mail-1/msg-1",
      react: vi.fn().mockResolvedValue(undefined),
    };
    run.mailChannelSend.mockResolvedValueOnce(posted);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.mailChannelSend).toHaveBeenCalledTimes(1);
    expect(run.mailChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.any(String),
        allowedMentions: { users: ["111"] },
      }),
    );
    const mainContent = String(run.mailChannelSend.mock.calls[0]?.[0]?.content ?? "");
    expect(mainContent).not.toContain("# Swap to WAR Bases");
    expect(mainContent).not.toContain("<@&123456789012345678>");
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = prismaMock.trackedMessage.upsert.mock.calls[0]?.[0];
    expect(upsertCall.create.metadata.swapReminder).toBe(true);
    expect(upsertCall.create.metadata.clanRoleId).toBe("123456789012345678");
  });

  it("publishes both split base-swap posts to the clan mail channel", async () => {
    const key = "split-mail-1";
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      username: "Requester",
      guildId: "guild-1",
      channelId: "invoke-1",
      mailChannelId: "mail-1",
      clanRoleId: null,
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: null,
        baseErrors: null,
        swapReminder: null,
      }),
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "111",
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: ["111"],
      swapReminder: false,
      createdAtIso: "2026-03-20T00:00:00.000Z",
      syncMessageId: "sync-message-1",
      splitContents: ["Part 1 content", "Part 2 content"],
    });

    const postedA = {
      id: "msg-1",
      url: "https://discord.com/channels/guild-1/mail-1/msg-1",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const postedB = {
      id: "msg-2",
      url: "https://discord.com/channels/guild-1/mail-1/msg-2",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const mailChannelSend = vi
      .fn()
      .mockResolvedValueOnce(postedA)
      .mockResolvedValueOnce(postedB);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      null,
    );
    const recordBasesChecked = vi
      .spyOn(repWorkActivityService, "recordBasesChecked")
      .mockResolvedValue(true);
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
      channelId: "invoke-1",
      client: {
        channels: {
          fetch: vi.fn().mockImplementation(async (channelId: string) => {
            if (channelId === "mail-1") {
              return {
                id: "mail-1",
                guildId: "guild-1",
                isTextBased: () => true,
                send: mailChannelSend,
              };
            }
            return null;
          }),
        },
      },
      channel: {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(undefined),
      },
      followUp: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleFwaBaseSwapSplitPostButton(interaction as any);

    expect(mailChannelSend).toHaveBeenCalledTimes(2);
    expect(mailChannelSend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "Part 1 content",
        allowedMentions: { users: ["111"] },
      }),
    );
    expect(mailChannelSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: "Part 2 content",
        allowedMentions: { users: ["111"] },
      }),
    );
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.trackedMessage.upsert.mock.calls) {
      expect(call[0].create.channelId).toBe("mail-1");
      expect(call[0].update.channelId).toBe("mail-1");
      expect(call[0].create.metadata.syncMessageId).toBe("sync-message-1");
      expect(call[0].update.metadata.syncMessageId).toBe("sync-message-1");
    }
    expect(postedA.react).toHaveBeenCalledWith(FWA_BASE_SWAP_ACK_EMOJI);
    expect(postedB.react).toHaveBeenCalledWith(FWA_BASE_SWAP_ACK_EMOJI);
    expect(recordBasesChecked).toHaveBeenCalledTimes(1);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(postedA.url),
        components: [],
      }),
    );
  });

  it("posts only the split base-swap messages during command execution when swap-reminder is enabled", async () => {
    const key = "split-mail-reminder-1";
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      username: "Requester",
      guildId: "guild-1",
      channelId: "invoke-1",
      mailChannelId: "mail-1",
      clanRoleId: "123456789012345678",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: "2",
        baseErrors: null,
        swapReminder: true,
      }),
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
          discordUserId: "111",
        }),
        buildEntry({
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "fwa_bases",
          discordUserId: "222",
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: ["111", "222"],
      swapReminder: true,
      createdAtIso: "2026-03-20T00:00:00.000Z",
      syncMessageId: "sync-message-1",
      splitContents: ["Part 1 content", "Part 2 content"],
    });

    const postedA = {
      id: "msg-1",
      url: "https://discord.com/channels/guild-1/mail-1/msg-1",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const postedB = {
      id: "msg-2",
      url: "https://discord.com/channels/guild-1/mail-1/msg-2",
      react: vi.fn().mockResolvedValue(undefined),
    };
    const mailChannelSend = vi
      .fn()
      .mockResolvedValueOnce(postedA)
      .mockResolvedValueOnce(postedB);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      null,
    );
    const recordBasesChecked = vi
      .spyOn(repWorkActivityService, "recordBasesChecked")
      .mockResolvedValue(true);
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
      channelId: "invoke-1",
      client: {
        channels: {
          fetch: vi.fn().mockImplementation(async (channelId: string) => {
            if (channelId === "mail-1") {
              return {
                id: "mail-1",
                guildId: "guild-1",
                isTextBased: () => true,
                send: mailChannelSend,
              };
            }
            return null;
          }),
        },
      },
      channel: {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(undefined),
      },
      followUp: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleFwaBaseSwapSplitPostButton(interaction as any);

    expect(mailChannelSend).toHaveBeenCalledTimes(2);
    expect(mailChannelSend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "Part 1 content",
        allowedMentions: { users: ["111", "222"] },
      }),
    );
    expect(mailChannelSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: "Part 2 content",
        allowedMentions: { users: ["111", "222"] },
      }),
    );
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.trackedMessage.upsert.mock.calls) {
      expect(call[0].create.metadata.syncMessageId).toBe("sync-message-1");
      expect(call[0].update.metadata.syncMessageId).toBe("sync-message-1");
    }
    expect(recordBasesChecked).toHaveBeenCalledTimes(1);
    const updatedContent = String(
      interaction.update.mock.calls[0]?.[0]?.content ?? "",
    );
    expect(updatedContent).toContain(
      "Posted split base swap announcements for **Test Clan** (#2QG2C08UP).",
    );
    expect(updatedContent).toContain(postedA.url);
    expect(updatedContent).toContain(postedB.url);
    expect(updatedContent).not.toContain("# Swap to WAR Bases");
    expect(updatedContent).not.toContain("<@&123456789012345678>");
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [],
      }),
    );
  });

  it("does not post when the tracked clan has no mail channel configured", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2QG2C08UP",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: null,
        clanRoleId: null,
      },
    ]);

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(run.client.channels.fetch).not.toHaveBeenCalled();
    expect(run.interaction.channel.send).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "No mail channel configured for Test Clan. Set the tracked clan mail channel first.",
      }),
    );
  });

  it("does not post when the configured mail channel is unavailable or not sendable", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2QG2C08UP",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
      },
    ]);
    run.client.channels.fetch.mockResolvedValueOnce({
      id: "mail-1",
      guildId: "guild-1",
      isTextBased: () => false,
      send: vi.fn(),
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(run.interaction.channel.send).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Configured mail channel for Test Clan is unavailable or not sendable.",
      }),
    );
  });

  it("does not post when the configured mail channel is missing from Discord", async () => {
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2QG2C08UP",
      warBases: "1",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: "mail-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "FWA",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: null,
            discordUserId: "111",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: "mail-1",
        clanRoleId: null,
      },
    ]);
    run.client.channels.fetch.mockResolvedValueOnce(null);

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(run.interaction.channel.send).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.upsert).not.toHaveBeenCalled();
    expect(run.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Configured mail channel for Test Clan is unavailable or not sendable.",
      }),
    );
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

  it("keeps base-error notes out of the generated in-game DM copy lines", () => {
    const content = buildFwaBaseSwapDmContentForTest([
      buildEntry({
        position: 2,
        playerTag: "#B1",
        playerName: "Two",
        section: "base_errors",
        townhallLevel: 16,
        baseErrorNote: "builder not separated by 6 spaces",
      }),
    ]);

    expect(content).toContain("Base error messages:");
    expect(content).toContain("`TH16 update FWA layout: !th16 @Two`");
    expect(content).not.toContain("builder not separated by 6 spaces");
  });

  it("includes a separate blacklist-war swap DM section for fwa-bases entries", () => {
    const lines = buildFwaBaseSwapFwaBaseDmLinesForTest([
      buildEntry({
        position: 5,
        playerTag: "#C1",
        playerName: "Charlie",
        section: "fwa_bases",
      }),
      buildEntry({
        position: 6,
        playerTag: "#D1",
        playerName: "Delta",
        section: "fwa_bases",
      }),
    ]);

    expect(lines).toEqual([
      "ACTIVE FWA BASE: swap to WAR BASE now @Charlie @Delta",
    ]);

    const content = buildFwaBaseSwapDmContentForTest([
      buildEntry({
        position: 1,
        playerTag: "#A1",
        playerName: "Alpha",
        section: "war_bases",
      }),
      buildEntry({
        position: 5,
        playerTag: "#C1",
        playerName: "Charlie",
        section: "fwa_bases",
      }),
    ]);

    expect(content).toContain("FWA base swap messages:");
    expect(content).toContain(
      "`ACTIVE FWA BASE: swap to WAR BASE now @Charlie`",
    );
    expect(content).toContain("----------");
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

describe("CWL base-swap labels", () => {
  it("renders CWL-specific labels in the announcement and DM copy blocks", () => {
    const announcementContent = renderFwaBaseSwapAnnouncementForTest({
      clanKind: "CWL",
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
          section: "fwa_bases",
          discordUserId: "101",
          townhallLevel: 17,
        }),
        buildEntry({
          position: 3,
          playerTag: "#CCC333",
          playerName: "Charlie",
          section: "base_errors",
          discordUserId: "102",
          townhallLevel: 16,
        }),
      ],
      layoutLinks: [],
      phaseTimingLine:
        "## Battle Day ends <t:1778093832:F> (<t:1778093832:R>)",
      alertEmoji: "<a:alert:10001>",
      fwaAlertEmoji: "<a:alert_blue:10003>",
    });
    const dmContent = buildFwaBaseSwapDmContentForTest([
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
        section: "fwa_bases",
        discordUserId: "101",
        townhallLevel: 17,
      }),
      buildEntry({
        position: 3,
        playerTag: "#CCC333",
        playerName: "Charlie",
        section: "base_errors",
        discordUserId: "102",
        townhallLevel: 16,
      }),
    ], "CWL");

    expect(announcementContent).toContain(
      "# <a:alert:10001> YOU HAVE AN ACTIVE WAR BASE <a:alert:10001>",
    );
    expect(announcementContent).toContain(
      "# <a:alert_blue:10003> YOU HAVE AN ACTIVE FWA BASE IN CWL <a:alert_blue:10003>",
    );
    expect(announcementContent).toContain(
      "These players currently have an active base in competitive CWL. Please swap to an active war base.",
    );
    expect(announcementContent).toContain(
      "\n## Battle Day ends <t:1778093832:F> (<t:1778093832:R>)",
    );
    expect(announcementContent).not.toContain(
      "\n\n## Battle Day ends <t:1778093832:F> (<t:1778093832:R>)",
    );
    expect(dmContent).toContain("CWL lineup swap messages:");
    expect(dmContent).toContain("CWL base error messages:");
    expect(dmContent).toContain("ACTIVE CWL LINEUP: swap to WAR BASE now");
    expect(dmContent).toContain("TH16 update CWL layout: !th16");
  });

  it("renders a competitive CWL swap-back reminder block with an optional role ping", () => {
    const reminderContent = renderFwaBaseSwapAnnouncementForTest({
      clanKind: "CWL",
      swapReminder: true,
      pingRoleId: "123456789012345678",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "fwa_bases",
          discordUserId: "100",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: "<a:alert:10001>",
      fwaAlertEmoji: "<a:alert_blue:10003>",
    });

    expect(reminderContent).toContain("# Swap Back to CWL Bases");
    expect(reminderContent).toContain(
      "Thanks for keeping active war bases up for competitive CWL. Please swap back to your CWL base for the next competitive CWL war.",
    );
    expect(reminderContent).toContain("<@&123456789012345678>");
    expect(reminderContent).toContain("React with");
    expect(reminderContent).toContain("YOU HAVE AN ACTIVE FWA BASE IN CWL");
  });

  it("posts CWL base-swap announcements in the invocation channel and pins them", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      null,
    );
    const run = makeBaseSwapCommandInteraction({
      clanTag: "#2qg2c08up",
      fwaBases: "1",
      swapReminder: true,
      pingRoleId: "123456789012345678",
      guildId: "guild-1",
      invokeChannelId: "invoke-1",
      mailChannelId: null,
      botLogChannelId: "bot-log-1",
    });
    baseSwapRosterMock.resolveBaseSwapRosterForClan.mockResolvedValue({
      ok: true,
      roster: {
        clanKind: "CWL",
        clanTag: "2QG2C08UP",
        clanName: "Test Clan",
        rosterMembers: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            townhallLevel: 18,
            discordUserId: "111",
            section: "fwa_bases",
          },
        ],
        phaseTiming: null,
      },
    });
    prismaMock.$queryRaw.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Test Clan",
        mailChannelId: null,
        clanRoleId: null,
        logChannelId: null,
        leaderChannelId: null,
      },
    ]);
    const posted = {
      id: "msg-cwl-1",
      url: "https://discord.com/channels/guild-1/invoke-1/msg-cwl-1",
      react: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
    };
    run.interactionChannelSend.mockResolvedValueOnce(posted);

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(run.interactionChannelSend).toHaveBeenCalledTimes(1);
    expect(run.mailChannelSend).not.toHaveBeenCalled();
    expect(run.interactionChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Swap Back to CWL Bases"),
        allowedMentions: {
          users: ["111"],
          roles: ["123456789012345678"],
        },
      }),
    );
    expect(posted.pin).toHaveBeenCalledTimes(1);
    const upsertCall = prismaMock.trackedMessage.upsert.mock.calls[0]?.[0];
    expect(upsertCall.create.channelId).toBe("invoke-1");
    expect(upsertCall.create.metadata.pingRoleId).toBe(
      "123456789012345678",
    );
    expect(upsertCall.create.metadata.clanRoleId).toBeNull();
    expect(String(run.editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      posted.url,
    );
  });

  it("publishes split CWL base-swap posts in the invocation channel and pins both posts", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      null,
    );
    const key = "split-cwl-1";
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      username: "Requester",
      guildId: "guild-1",
      channelId: "invoke-1",
      mailChannelId: "invoke-1",
      clanRoleId: null,
      pingRoleId: "123456789012345678",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      clanKind: "CWL",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: null,
        fwaBases: "1",
        baseErrors: null,
        swapReminder: true,
        pingRoleId: "123456789012345678",
      }),
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "fwa_bases",
          discordUserId: "111",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: ["111"],
      swapReminder: true,
      createdAtIso: "2026-03-20T00:00:00.000Z",
      syncMessageId: "sync-message-1",
      splitContents: ["Part 1 content", "Part 2 content"],
    });

    const postedA = {
      id: "msg-cwl-a",
      url: "https://discord.com/channels/guild-1/invoke-1/msg-cwl-a",
      react: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
    };
    const postedB = {
      id: "msg-cwl-b",
      url: "https://discord.com/channels/guild-1/invoke-1/msg-cwl-b",
      react: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = {
      customId: buildFwaBaseSwapSplitPostCustomId({
        userId: "user-1",
        key,
        action: "yes",
      }),
      user: {
        id: "user-1",
        username: "Requester",
        send: vi.fn().mockResolvedValue(undefined),
      },
      guildId: "guild-1",
      channelId: "invoke-1",
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
      channel: {
        id: "invoke-1",
        guildId: "guild-1",
        isTextBased: () => true,
        send: vi
          .fn()
          .mockResolvedValueOnce(postedA)
          .mockResolvedValueOnce(postedB),
      },
      followUp: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleFwaBaseSwapSplitPostButton(interaction as any);

    expect(interaction.channel.send).toHaveBeenCalledTimes(2);
    expect(interaction.channel.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "Part 1 content",
        allowedMentions: {
          users: ["111"],
          roles: ["123456789012345678"],
        },
      }),
    );
    expect(interaction.channel.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: "Part 2 content",
        allowedMentions: {
          users: ["111"],
          roles: ["123456789012345678"],
        },
      }),
    );
    expect(postedA.pin).toHaveBeenCalledTimes(1);
    expect(postedB.pin).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.trackedMessage.upsert.mock.calls) {
      expect(call[0].create.channelId).toBe("invoke-1");
      expect(call[0].create.metadata.clanKind).toBe("CWL");
      expect(call[0].create.metadata.pingRoleId).toBe(
        "123456789012345678",
      );
      expect(call[0].create.metadata.clanRoleId).toBeNull();
    }
  });

  it("rejects out-of-range CWL lineup positions with a valid range", () => {
    const result = buildBaseSwapAnnouncementEntriesForTest({
      clanKind: "CWL",
      clanTag: "2QG2C08UP",
      roster: [
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          townhallLevel: 18,
          discordUserId: "100",
        },
        {
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          townhallLevel: 17,
          discordUserId: "101",
        },
      ],
      selections: [
        {
          label: "war-bases",
          section: "war_bases",
          positions: [3],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error).toContain(
      "Invalid positions in the current active CWL lineup for #2QG2C08UP: #3.",
    );
    expect(result.error).toContain("Valid range is #1-#2.");
  });

  it("rejects missing CWL lineup slots with a clear lineup message", () => {
    const result = buildBaseSwapAnnouncementEntriesForTest({
      clanKind: "CWL",
      clanTag: "2QG2C08UP",
      roster: [
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          townhallLevel: 18,
          discordUserId: "100",
        },
        {
          position: 3,
          playerTag: "#CCC333",
          playerName: "Charlie",
          townhallLevel: 16,
          discordUserId: "102",
        },
      ],
      selections: [
        {
          label: "base-errors",
          section: "base_errors",
          positions: [2],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error).toContain(
      "These positions were not found in the current active CWL lineup for #2QG2C08UP: #2.",
    );
  });
});

describe("FWA base-swap bot-log audit", () => {
  it("builds a compact audit log with user, channel, links, and command text", () => {
    const content = buildFwaBaseSwapAuditLogContentForTest({
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      sourceChannelId: "channel-1",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1,4",
        fwaBases: "5,6",
        baseErrors:
          "15 builder not separated by 6 spaces, 19 revenge tower not in corner, 23 26, 32 firespitters facing wrong direction, 43",
        swapReminder: true,
      }),
      messageUrls: [
        "https://discord.com/channels/guild-1/channel-1/msg-1",
      ],
    });

    expect(content).toContain("**FWA base-swap announcement posted**");
    expect(content).toContain(
      "<@user-1> (driedsheets, user-1) posted /fwa base-swap in <#channel-1> for Test Clan (#2QG2C08UP)",
    );
    expect(content).toContain("Posted message link(s):");
    expect(content).toContain(
      "https://discord.com/channels/guild-1/channel-1/msg-1",
    );
    expect(content).toContain(
      "Command: `/fwa base-swap clan:2QG2C08UP war-bases:1,4 fwa-bases:5,6 base-errors:15 builder not separated by 6 spaces, 19 revenge tower not in corner, 23 26, 32 firespitters facing wrong direction, 43 swap-reminder:true`",
    );
    expect(content).not.toContain("Source channel:");
    expect(content).not.toContain("```text");
    expect(content).not.toContain("```");
  });

  it("renders multiple posted links without a verbose block", () => {
    const content = buildFwaBaseSwapAuditLogContentForTest({
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      sourceChannelId: "channel-1",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: null,
        baseErrors: null,
        swapReminder: null,
      }),
      messageUrls: [
        "https://discord.com/channels/guild-1/channel-1/msg-1",
        "https://discord.com/channels/guild-1/channel-1/msg-2",
      ],
    });

    expect(content).toContain("Posted message link(s):");
    expect(content).toContain(
      "https://discord.com/channels/guild-1/channel-1/msg-1",
    );
    expect(content).toContain(
      "https://discord.com/channels/guild-1/channel-1/msg-2",
    );
    expect(content).toContain("- https://discord.com/channels/guild-1/channel-1/msg-2");
    expect(content).not.toContain("Source channel:");
    expect(content).not.toContain("```text");
  });

  it("does not include persistent audit routing in the reconstructed command text", () => {
    const commandText = buildFwaBaseSwapCommandTextForTest({
      clanTag: "2QG2C08UP",
      warBases: "1",
      fwaBases: "5",
      baseErrors: "2",
      swapReminder: true,
    });

    expect(commandText).toContain("/fwa base-swap clan:2QG2C08UP");
    expect(commandText).not.toContain("log-enable:");
    expect(commandText).not.toContain("channel:<#");
  });

  it("sends the audit log to the configured generic bot-log channel when no typed channel is configured", async () => {
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          guildId: "guild-1",
          isTextBased: () => true,
          send: botLogSend,
        }),
      },
    } as any;

    await logFwaBaseSwapPublicationForTest({
      client,
      guildId: "guild-1",
      sourceChannelId: "channel-1",
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: "5",
        baseErrors: "2",
        swapReminder: true,
      }),
      messageUrls: ["https://discord.com/channels/guild-1/channel-1/msg-1"],
    });

    expect(client.channels.fetch).toHaveBeenCalledWith("bot-log-1");
    expect(botLogSend).toHaveBeenCalledTimes(1);
    const payload = botLogSend.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain(
      "**FWA base-swap announcement posted**",
    );
    expect(String(payload.content ?? "")).toContain(
      "<@user-1> (driedsheets, user-1) posted /fwa base-swap in <#channel-1> for Test Clan (#2QG2C08UP)",
    );
    expect(String(payload.content ?? "")).toContain("Posted message link(s):");
    expect(String(payload.content ?? "")).toContain(
      "Command: `/fwa base-swap clan:2QG2C08UP war-bases:1 fwa-bases:5 base-errors:2 swap-reminder:true`",
    );
  });

  it("sends the audit log to the typed base-swap bot-log channel when configured", async () => {
    const typedBotLogSend = vi.fn().mockResolvedValue(undefined);
    const genericBotLogSend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "typed-bot-log-1",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );
    const client = {
      channels: {
        fetch: vi.fn().mockImplementation(async (channelId: string) => {
          if (channelId === "typed-bot-log-1") {
            return {
              guildId: "guild-1",
              isTextBased: () => true,
              send: typedBotLogSend,
            };
          }
          if (channelId === "bot-log-1") {
            return {
              guildId: "guild-1",
              isTextBased: () => true,
              send: genericBotLogSend,
            };
          }
          return null;
        }),
      },
    } as any;

    await logFwaBaseSwapPublicationForTest({
      client,
      guildId: "guild-1",
      sourceChannelId: "channel-1",
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: "5",
        baseErrors: "2",
        swapReminder: true,
      }),
      messageUrls: ["https://discord.com/channels/guild-1/channel-1/msg-1"],
    });

    expect(client.channels.fetch).toHaveBeenCalledWith("typed-bot-log-1");
    expect(client.channels.fetch).not.toHaveBeenCalledWith("bot-log-1");
    expect(typedBotLogSend).toHaveBeenCalledTimes(1);
    expect(genericBotLogSend).not.toHaveBeenCalled();
    const payload = typedBotLogSend.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain(
      "**FWA base-swap announcement posted**",
    );
    expect(String(payload.content ?? "")).not.toContain("Source channel:");
  });

  it("clears stale typed bot-log config and can fall back to generic routing", async () => {
    const genericBotLogSend = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clearTypedSpy = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "typed-bot-log-1",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );
    const client = {
      channels: {
        fetch: vi.fn().mockImplementation(async (channelId: string) => {
          if (channelId === "typed-bot-log-1") {
            return null;
          }
          if (channelId === "bot-log-1") {
            return {
              guildId: "guild-1",
              isTextBased: () => true,
              send: genericBotLogSend,
            };
          }
          return null;
        }),
      },
    } as any;

    await logFwaBaseSwapPublicationForTest({
      client,
      guildId: "guild-1",
      sourceChannelId: "channel-1",
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: "5",
        baseErrors: "2",
        swapReminder: true,
      }),
      messageUrls: ["https://discord.com/channels/guild-1/channel-1/msg-1"],
    });

    expect(client.channels.fetch).toHaveBeenCalledWith("typed-bot-log-1");
    expect(client.channels.fetch).toHaveBeenCalledWith("bot-log-1");
    expect(genericBotLogSend).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mode=bot-log channel"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=missing"),
    );
    expect(warnSpy.mock.calls.some((call) => String(call[0] ?? "").includes("destination=typed-bot-log-1"))).toBe(true);
    expect(clearTypedSpy).toHaveBeenCalledWith(
      "guild-1",
      "base-swap",
    );
  });

  it("does not clear typed base-swap bot-log config on transient fetch failures", async () => {
    const genericBotLogSend = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clearTypedSpy = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "typed-bot-log-1",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );
    const client = {
      channels: {
        fetch: vi.fn().mockImplementation(async (channelId: string) => {
          if (channelId === "typed-bot-log-1") {
            throw Object.assign(new Error("boom"), { code: 500 });
          }
          if (channelId === "bot-log-1") {
            return {
              guildId: "guild-1",
              isTextBased: () => true,
              send: genericBotLogSend,
            };
          }
          return null;
        }),
      },
    } as any;

    await logFwaBaseSwapPublicationForTest({
      client,
      guildId: "guild-1",
      sourceChannelId: "channel-1",
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: "5",
        baseErrors: "2",
        swapReminder: true,
      }),
      messageUrls: ["https://discord.com/channels/guild-1/channel-1/msg-1"],
    });

    expect(client.channels.fetch).toHaveBeenCalledWith("typed-bot-log-1");
    expect(client.channels.fetch).toHaveBeenCalledWith("bot-log-1");
    expect(genericBotLogSend).toHaveBeenCalledTimes(1);
    expect(clearTypedSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=fetch_failed"),
    );
  });

  it("does not clear typed base-swap bot-log config when the channel is not sendable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clearTypedSpy = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "typed-bot-log-1",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(null);
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          guildId: "guild-1",
          isTextBased: () => true,
          send: undefined,
        }),
      },
    } as any;

    await logFwaBaseSwapPublicationForTest({
      client,
      guildId: "guild-1",
      sourceChannelId: "channel-1",
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: "5",
        baseErrors: "2",
        swapReminder: true,
      }),
      messageUrls: ["https://discord.com/channels/guild-1/channel-1/msg-1"],
    });

    expect(client.channels.fetch).toHaveBeenCalledWith("typed-bot-log-1");
    expect(clearTypedSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=not_sendable"),
    );
  });

  it("does nothing when no bot-log channel is configured", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      null,
    );
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          guildId: "guild-1",
          isTextBased: () => true,
          send: botLogSend,
        }),
      },
    } as any;

    await logFwaBaseSwapPublicationForTest({
      client,
      guildId: "guild-1",
      sourceChannelId: "channel-1",
      userId: "user-1",
      username: "Requester",
      displayName: "driedsheets",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1",
        fwaBases: null,
        baseErrors: null,
        swapReminder: null,
      }),
      messageUrls: ["https://discord.com/channels/guild-1/channel-1/msg-1"],
    });

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(botLogSend).not.toHaveBeenCalled();
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
