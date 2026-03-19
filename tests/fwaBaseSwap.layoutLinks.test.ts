import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  FWA_BASE_SWAP_ACK_EMOJI,
  FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI,
  FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI,
  buildFwaBaseSwapPhaseTimingLineForTest,
  renderFwaBaseSwapAnnouncementForTest,
} from "../src/commands/Fwa";
import {
  FwaBaseSwapTrackedMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  TrackedMessageService,
} from "../src/services/TrackedMessageService";

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

    const th18Line = `## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18 Link: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>`;
    const th17Line = `## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH17 Link: <https://link.clashofclans.com/en?action=OpenLayout&id=TH17%3AWB%3AAAAARQAAAAI6ppxkTfH3WnNJjWK96bqn>`;
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

    const th18Occurrences = (content.match(/TH18 Link:/g) ?? []).length;
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
      "## <a:arrow_arrow:10002> TH18 Link: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>",
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
      `## ${FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI} TH18 Link: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>`,
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

    expect(content).toContain("TH18 Link:");
    expect(content).not.toContain("TH17 Link:");
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
      edit: vi.fn().mockResolvedValue(undefined),
    };

    const changed = await service.handleFwaBaseSwapReaction({
      messageId: "message-1",
      reactorUserId: "reactor-1",
      message,
      render: renderFwaBaseSwapAnnouncementForTest,
      truncate: (text) => text,
    });

    expect(changed).toBe(true);
    expect(message.edit).toHaveBeenCalledTimes(1);
    const editPayload = message.edit.mock.calls[0]?.[0];
    expect(String(editPayload.content)).toContain(
      "## <a:arrow_arrow:10002> TH18 Link: <https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAABQAAAAL-snjB9XgCUUcMqq1dHYjg>"
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
});
