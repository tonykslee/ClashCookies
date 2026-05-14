import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
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
  TrackedMessageService,
} from "../src/services/TrackedMessageService";

beforeEach(() => {
  clearFwaBaseSwapSplitPostPayloadsForTest();
});

function buildEntry(input: {
  position: number;
  playerTag: string;
  playerName: string;
  section: "war_bases" | "base_errors" | "fwa_bases";
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

  it("rejects invalid tokens and duplicate inputs for all base-swap args", () => {
    const cases = [
      { label: "war-bases", section: "war_bases" as const },
      { label: "base-errors", section: "base_errors" as const },
      { label: "fwa-bases", section: "fwa_bases" as const },
    ];

    for (const { label, section } of cases) {
      const invalid = parseFwaBaseSwapPositionSelectionsForTest({
        selections: [
          {
            label,
            section,
            raw: "1,abc",
          },
        ],
      });
      expect(invalid).toEqual({
        ok: false,
        error:
          `Invalid positions in \`${label}\`: abc. Use comma-separated or space-separated positive roster positions like \`1, 4, 7\`.`,
      });

      const duplicate = parseFwaBaseSwapPositionSelectionsForTest({
        selections: [
          {
            label,
            section,
            raw: "1,1",
          },
        ],
      });
      expect(duplicate).toEqual({
        ok: false,
        error: `Duplicate positions in \`${label}\`: #1.`,
      });
    }
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

  it("allows swap-reminder only when fwa-bases is present", () => {
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        fwaBasesRaw: null,
        swapReminderRaw: true,
      }),
    ).toBe("`swap-reminder` can only be used when `fwa-bases` is provided.");
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        fwaBasesRaw: null,
        swapReminderRaw: false,
      }),
    ).toBe("`swap-reminder` can only be used when `fwa-bases` is provided.");
    expect(
      validateFwaBaseSwapSwapReminderOptionForTest({
        fwaBasesRaw: "1,2",
        swapReminderRaw: null,
      }),
    ).toBeNull();
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

  it("updates fwa-bases rows from :x: to the acknowledged mark on reaction", async () => {
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
          section: "fwa_bases",
          discordUserId: "reactor-1",
          acknowledged: false,
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
    expect(String(editPayload.content)).toContain("#1 - <@reactor-1> - Alpha -");
    expect(String(editPayload.content)).toContain(FWA_BASE_SWAP_ACK_EMOJI);
    expect(String(editPayload.content)).not.toContain(":x:");
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
      swapReminder: false,
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
    setFwaBaseSwapSplitPostPayloadForTest(key, {
      userId: "user-1",
      username: "Requester",
      guildId: "guild-1",
      channelId: "channel-1",
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
          discordUserId: "user-1",
          townhallLevel: 18,
        }),
      ],
      layoutLinks: [],
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      mentionUserIds: ["user-1"],
      swapReminder: false,
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
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "bot-log-1",
    );

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
          fetch: vi.fn().mockResolvedValue({
            guildId: "guild-1",
            isTextBased: () => true,
            send: botLogSend,
          }),
        },
      },
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
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(String(botLogSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Test Clan (#2QG2C08UP)",
    );
    expect(String(botLogSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Source channel: <#channel-1>",
    );
    expect(String(botLogSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      postedA.url,
    );
    expect(String(botLogSend.mock.calls[0]?.[0]?.content ?? "")).toContain(
      postedB.url,
    );
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
      username: "Requester",
      guildId: "guild-1",
      channelId: "channel-1",
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
      "These players currently have an active FWA base in CWL. Please swap to an active war base.",
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
  it("builds a structured audit log with user, source channel, links, and command text", () => {
    const content = buildFwaBaseSwapAuditLogContentForTest({
      userId: "user-1",
      username: "Requester",
      sourceChannelId: "channel-1",
      clanTag: "2QG2C08UP",
      clanName: "Test Clan",
      commandText: buildFwaBaseSwapCommandTextForTest({
        clanTag: "2QG2C08UP",
        warBases: "1,4",
        fwaBases: "5,6",
        baseErrors: "2,3",
        swapReminder: true,
      }),
      messageUrls: [
        "https://discord.com/channels/guild-1/channel-1/msg-1",
      ],
    });

    expect(content).toContain("FWA base-swap announcement posted");
    expect(content).toContain("<@user-1> (Requester, user-1) posted /fwa base-swap");
    expect(content).toContain("Source channel: <#channel-1>");
    expect(content).toContain("Posted message link(s):");
    expect(content).toContain(
      "https://discord.com/channels/guild-1/channel-1/msg-1",
    );
    expect(content).toContain(
      "/fwa base-swap clan:2QG2C08UP war-bases:1,4 fwa-bases:5,6 base-errors:2,3 swap-reminder:true",
    );
  });

  it("sends the audit log to the configured bot-log channel when available", async () => {
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
    expect(String(payload.content ?? "")).toContain("Test Clan (#2QG2C08UP)");
    expect(String(payload.content ?? "")).toContain("Source channel: <#channel-1>");
    expect(String(payload.content ?? "")).toContain(
      "/fwa base-swap clan:2QG2C08UP war-bases:1 fwa-bases:5 base-errors:2 swap-reminder:true",
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
