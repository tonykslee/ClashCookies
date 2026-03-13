import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
} from "discord.js";
import { type WarComplianceIssue } from "../../services/WarComplianceService";
import { buildFwaComplianceViewCustomId } from "./customIds";

export type FwaComplianceActiveView = "fwa_main" | "missed";

export type FwaComplianceEmbedRenderInput = {
  userId: string;
  key: string;
  isFwa: boolean;
  clanName: string;
  warPlanText?: string | null;
  warId: number | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  participantsCount: number;
  attacksCount: number;
  missedBoth: WarComplianceIssue[];
  notFollowingPlan: WarComplianceIssue[];
  activeView: FwaComplianceActiveView;
  mainPage: number;
  missedPage: number;
};

export type FwaComplianceEmbedRenderOutput = {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
  mainPage: number;
  missedPage: number;
  mainPageCount: number;
  missedPageCount: number;
};

type ParsedActualBehavior = {
  attacks: Array<{
    defenderPosition: number | null;
    stars: number;
  }>;
  reason: string;
  strictContext: string | null;
};

const FIELD_LIMIT = 1024;
const PAGE_CONTENT_LIMIT = 980;

/** Purpose: render numeric stars as spaced triplets to match existing compliance visuals. */
function formatStarTriplet(stars: number | null | undefined): string {
  const normalized = Math.max(0, Math.min(3, Number(stars ?? 0)));
  if (normalized >= 3) return "★ ★ ★";
  if (normalized >= 2) return "★ ★ ☆";
  if (normalized >= 1) return "★ ☆ ☆";
  return "☆ ☆ ☆";
}

/** Purpose: convert serialized star glyphs into numeric star values for fallback parsing. */
function parseStarTripletToCount(input: string): number {
  const text = String(input ?? "");
  const matches = text.match(/★|â˜…/g);
  const count = matches ? matches.length : 0;
  return Math.max(0, Math.min(3, count));
}

/** Purpose: sort compliance rows by roster position first for deterministic paging. */
function sortIssuesDeterministically(issues: WarComplianceIssue[]): WarComplianceIssue[] {
  return [...issues].sort((a, b) => {
    const posA = Number.isFinite(Number(a.playerPosition))
      ? Number(a.playerPosition)
      : Number.MAX_SAFE_INTEGER;
    const posB = Number.isFinite(Number(b.playerPosition))
      ? Number(b.playerPosition)
      : Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    const nameA = String(a.playerName ?? "").trim() || String(a.playerTag ?? "").trim();
    const nameB = String(b.playerName ?? "").trim() || String(b.playerTag ?? "").trim();
    const nameDelta = nameA.localeCompare(nameB);
    if (nameDelta !== 0) return nameDelta;
    return String(a.playerTag ?? "").localeCompare(String(b.playerTag ?? ""));
  });
}

/** Purpose: keep pagination bounded to valid page indexes. */
function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 0;
  if (pageCount <= 1) return 0;
  return Math.max(0, Math.min(Math.trunc(page), pageCount - 1));
}

/** Purpose: paginate variable-size text blocks without relying on silent truncation. */
function paginateBlocks(blocks: string[], separator = "\n\n"): string[] {
  if (blocks.length === 0) return ["No entries."];
  const pages: string[] = [];
  let current = "";

  for (const rawBlock of blocks) {
    const block = String(rawBlock ?? "").trim();
    if (!block) continue;
    const next = current ? `${current}${separator}${block}` : block;
    if (next.length <= PAGE_CONTENT_LIMIT) {
      current = next;
      continue;
    }
    if (current) {
      pages.push(current);
      current = "";
    }
    if (block.length <= PAGE_CONTENT_LIMIT) {
      current = block;
      continue;
    }
    pages.push(`${block.slice(0, PAGE_CONTENT_LIMIT - 12)}\n(+truncated)`);
  }

  if (current) {
    pages.push(current);
  }

  return pages.length > 0 ? pages : ["No entries."];
}

/** Purpose: transform persisted violation behavior text into embed-friendly block lines. */
function parseActualBehavior(actualBehavior: string): ParsedActualBehavior {
  const raw = String(actualBehavior ?? "").trim();
  if (!raw) {
    return {
      attacks: [],
      reason: "No details available.",
      strictContext: null,
    };
  }

  const separatorIndex = raw.indexOf(" : ");
  if (separatorIndex <= -1) {
    return {
      attacks: [],
      reason: "No details available.",
      strictContext: null,
    };
  }

  const targetsRaw = raw.slice(0, separatorIndex).trim();
  const reasonRaw = raw.slice(separatorIndex + 3).trim();
  const reasonParts = reasonRaw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  const attacks = targetsRaw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = chunk.match(/^#(\d+)\s*\(([^)]*)\)$/);
      if (!match) {
        return {
          defenderPosition: null,
          stars: parseStarTripletToCount(chunk),
        };
      }
      return {
        defenderPosition: Number(match[1]),
        stars: parseStarTripletToCount(match[2] ?? ""),
      };
    });

  return {
    attacks,
    reason: reasonParts[0] ?? "No details available.",
    strictContext: reasonParts.length > 1 ? reasonParts.slice(1).join(" | ") : null,
  };
}

/** Purpose: infer breach markers for legacy parsed rows when structured attackDetails are unavailable. */
function buildFallbackAttackDetails(
  issue: WarComplianceIssue,
  parsed: ParsedActualBehavior
): Array<{ defenderPosition: number | null; stars: number; isBreach: boolean }> {
  const details = parsed.attacks.map((row) => ({
    defenderPosition: row.defenderPosition,
    stars: row.stars,
    isBreach: false,
  }));
  const reason = String(issue.reasonLabel ?? parsed.reason ?? "").toLowerCase();
  const playerPos =
    Number.isFinite(Number(issue.playerPosition)) && Number(issue.playerPosition) > 0
      ? Number(issue.playerPosition)
      : null;

  if (reason.includes("tripled non-mirror")) {
    for (const row of details) {
      if (row.stars >= 3 && row.defenderPosition !== null && row.defenderPosition !== playerPos) {
        row.isBreach = true;
      }
    }
  } else if (reason.includes("didn't triple mirror")) {
    for (const row of details) {
      const isMirrorTriple =
        playerPos !== null && row.defenderPosition === playerPos && row.stars >= 3;
      if (!isMirrorTriple) {
        row.isBreach = true;
      }
    }
  }

  if (!details.some((row) => row.isBreach) && details.length > 0 && parsed.strictContext) {
    details[0].isBreach = true;
  }
  return details;
}

/** Purpose: render one not-following issue into the required multi-line violation block. */
function renderViolationBlock(issue: WarComplianceIssue): string {
  const parsed = parseActualBehavior(issue.actualBehavior);
  const name = String(issue.playerName ?? "").trim() || "Unknown member";
  const pos = Number.isFinite(Number(issue.playerPosition))
    ? `#${Math.trunc(Number(issue.playerPosition))}`
    : "#?";
  const lines = [`${pos} ${name}`];

  const details =
    issue.attackDetails && issue.attackDetails.length > 0
      ? issue.attackDetails.map((detail) => ({
          defenderPosition: detail.defenderPosition ?? null,
          stars: Math.max(0, Math.min(3, Number(detail.stars ?? 0))),
          isBreach: Boolean(detail.isBreach),
        }))
      : buildFallbackAttackDetails(issue, parsed);

  if (details.length <= 0) {
    lines.push("→ No targets logged.");
  } else {
    for (const detail of details) {
      const target = detail.defenderPosition !== null ? `#${detail.defenderPosition}` : "#?";
      lines.push(
        `→ ${target} ${formatStarTriplet(detail.stars)}${detail.isBreach ? " ⚠️" : ""}`
      );
    }
  }

  const contextLine = issue.breachContext
    ? `${issue.breachContext.starsAtBreach}★ | ${issue.breachContext.timeRemaining}`
    : parsed.strictContext;
  if (contextLine) {
    lines.push(contextLine);
  }
  return lines.join("\n");
}

/** Purpose: render one missed-both issue line in `Name (#TAG)` format. */
function renderMissedLine(issue: WarComplianceIssue): string {
  const name = String(issue.playerName ?? "").trim() || "Unknown member";
  const tag = String(issue.playerTag ?? "").trim();
  if (!tag || tag === "UNKNOWN") return name;
  return `${name} (${tag})`;
}

/** Purpose: build deterministic summary text for the main FWA compliance embed. */
function buildSummaryFieldValue(input: {
  attacksCount: number;
  missedCount: number;
  violationCount: number;
}): string {
  return [
    `⚔️ Attacks Logged: ${input.attacksCount}`,
    `❌ Missed Both Attacks: ${input.missedCount}`,
    `⚠️ Didn't Follow Plan: ${input.violationCount}`,
  ].join("\n");
}

/** Purpose: normalize compliance warplan field text into a safe non-empty embed value. */
function buildWarPlanFieldValue(warPlanText: string | null | undefined): string {
  const text = String(warPlanText ?? "").trim();
  return text || "No warplan details";
}

/** Purpose: safely build the war description with unknown fallbacks required by command contract. */
function buildWarDescription(input: {
  warId: number | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
}): string {
  const warIdLabel = input.warId ?? "unknown";
  const expected = input.expectedOutcome ?? "UNKNOWN";
  const startLine =
    input.warStartTime instanceof Date
      ? `Start <t:${Math.floor(input.warStartTime.getTime() / 1000)}:f>`
      : "Start unknown";
  const endLine =
    input.warEndTime instanceof Date
      ? `End <t:${Math.floor(input.warEndTime.getTime() / 1000)}:R>`
      : "End unknown";
  return [`War #${warIdLabel} • Expected: ${expected}`, startLine, endLine].join("\n");
}

/** Purpose: build the paged FWA-main compliance embed (summary + plan violations). */
function buildMainEmbed(input: {
  clanName: string;
  warPlanText?: string | null;
  warId: number | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  attacksCount: number;
  missedBoth: WarComplianceIssue[];
  violations: WarComplianceIssue[];
  page: number;
}): { embed: EmbedBuilder; page: number; pageCount: number } {
  const sortedViolations = sortIssuesDeterministically(input.violations);
  const violationPages = paginateBlocks(sortedViolations.map(renderViolationBlock));
  const page = clampPage(input.page, violationPages.length);
  const value = violationPages[page] ?? "No plan violations found.";
  const safeValue = value.length <= FIELD_LIMIT ? value : `${value.slice(0, FIELD_LIMIT - 12)}\n(+truncated)`;

  const embed = new EmbedBuilder()
    .setTitle(`FWA War Compliance — ${input.clanName}`)
    .setDescription(
      buildWarDescription({
        warId: input.warId,
        expectedOutcome: input.expectedOutcome,
        warStartTime: input.warStartTime,
        warEndTime: input.warEndTime,
      })
    )
    .addFields(
      {
        name: "Summary",
        value: buildSummaryFieldValue({
          attacksCount: input.attacksCount,
          missedCount: input.missedBoth.length,
          violationCount: input.violations.length,
        }),
      },
      {
        name: "Warplan",
        value: buildWarPlanFieldValue(input.warPlanText),
      },
      {
        name: "Plan Violations",
        value: safeValue || "No plan violations found.",
      }
    )
    .setFooter({ text: `Page ${page + 1}/${violationPages.length}` });

  return {
    embed,
    page,
    pageCount: violationPages.length,
  };
}

/** Purpose: build the paged missed-attacks embed used by both FWA and non-FWA flows. */
function buildMissedEmbed(input: {
  clanName: string;
  warId: number | null;
  missedBoth: WarComplianceIssue[];
  page: number;
}): { embed: EmbedBuilder; page: number; pageCount: number } {
  const sortedMissed = sortIssuesDeterministically(input.missedBoth);
  const missedLines =
    sortedMissed.length > 0
      ? sortedMissed.map(renderMissedLine)
      : ["No players missed both attacks."];
  const missedPages = paginateBlocks(missedLines, "\n");
  const page = clampPage(input.page, missedPages.length);
  const value = missedPages[page] ?? "No players missed both attacks.";
  const safeValue = value.length <= FIELD_LIMIT ? value : `${value.slice(0, FIELD_LIMIT - 12)}\n(+truncated)`;
  const warIdLabel = input.warId ?? "unknown";

  const embed = new EmbedBuilder()
    .setTitle(`Missed Attacks — ${input.clanName}`)
    .setDescription(`War #${warIdLabel} • Missed Both Attacks: ${sortedMissed.length}`)
    .addFields({
      name: "Players",
      value: safeValue || "No players missed both attacks.",
    })
    .setFooter({ text: `Page ${page + 1}/${missedPages.length}` });

  return {
    embed,
    page,
    pageCount: missedPages.length,
  };
}

/** Purpose: attach deterministic navigation controls for the active compliance view/page. */
function buildComponents(input: {
  userId: string;
  key: string;
  isFwa: boolean;
  activeView: FwaComplianceActiveView;
  missedCount: number;
  mainPage: number;
  mainPageCount: number;
  missedPage: number;
  missedPageCount: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (input.activeView === "fwa_main") {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildFwaComplianceViewCustomId({
              userId: input.userId,
              key: input.key,
              action: "open_missed",
            })
          )
          .setLabel("Missed Attacks")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(input.missedCount <= 0)
      )
    );
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildFwaComplianceViewCustomId({
              userId: input.userId,
              key: input.key,
              action: "prev",
            })
          )
          .setLabel("Prev")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(input.mainPage <= 0),
        new ButtonBuilder()
          .setCustomId(
            buildFwaComplianceViewCustomId({
              userId: input.userId,
              key: input.key,
              action: "next",
            })
          )
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(input.mainPage >= input.mainPageCount - 1)
      )
    );
    return rows;
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildFwaComplianceViewCustomId({
            userId: input.userId,
            key: input.key,
            action: "open_main",
          })
        )
        .setLabel(input.isFwa ? "Back to FWA Compliance" : "FWA Compliance")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!input.isFwa)
    )
  );
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildFwaComplianceViewCustomId({
            userId: input.userId,
            key: input.key,
            action: "prev",
          })
        )
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(input.missedPage <= 0),
      new ButtonBuilder()
        .setCustomId(
          buildFwaComplianceViewCustomId({
            userId: input.userId,
            key: input.key,
            action: "next",
          })
        )
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(input.missedPage >= input.missedPageCount - 1)
    )
  );
  return rows;
}

/** Purpose: render the active compliance view embed + components while keeping page bounds consistent. */
export function buildFwaComplianceEmbedView(
  input: FwaComplianceEmbedRenderInput
): FwaComplianceEmbedRenderOutput {
  if (input.activeView === "fwa_main") {
    const main = buildMainEmbed({
      clanName: input.clanName,
      warPlanText: input.warPlanText,
      warId: input.warId,
      expectedOutcome: input.expectedOutcome,
      warStartTime: input.warStartTime,
      warEndTime: input.warEndTime,
      attacksCount: input.attacksCount,
      missedBoth: input.missedBoth,
      violations: input.notFollowingPlan,
      page: input.mainPage,
    });
    const missed = buildMissedEmbed({
      clanName: input.clanName,
      warId: input.warId,
      missedBoth: input.missedBoth,
      page: input.missedPage,
    });

    return {
      embed: main.embed,
      components: buildComponents({
        userId: input.userId,
        key: input.key,
        isFwa: input.isFwa,
        activeView: input.activeView,
        missedCount: input.missedBoth.length,
        mainPage: main.page,
        mainPageCount: main.pageCount,
        missedPage: missed.page,
        missedPageCount: missed.pageCount,
      }),
      mainPage: main.page,
      missedPage: missed.page,
      mainPageCount: main.pageCount,
      missedPageCount: missed.pageCount,
    };
  }

  const missed = buildMissedEmbed({
    clanName: input.clanName,
    warId: input.warId,
    missedBoth: input.missedBoth,
    page: input.missedPage,
  });
  const main = buildMainEmbed({
    clanName: input.clanName,
    warPlanText: input.warPlanText,
    warId: input.warId,
    expectedOutcome: input.expectedOutcome,
    warStartTime: input.warStartTime,
    warEndTime: input.warEndTime,
    attacksCount: input.attacksCount,
    missedBoth: input.missedBoth,
    violations: input.notFollowingPlan,
    page: input.mainPage,
  });

  return {
    embed: missed.embed,
    components: buildComponents({
      userId: input.userId,
      key: input.key,
      isFwa: input.isFwa,
      activeView: input.activeView,
      missedCount: input.missedBoth.length,
      mainPage: main.page,
      mainPageCount: main.pageCount,
      missedPage: missed.page,
      missedPageCount: missed.pageCount,
    }),
    mainPage: main.page,
    missedPage: missed.page,
    mainPageCount: main.pageCount,
    missedPageCount: missed.pageCount,
  };
}

/** Purpose: expose embed JSON for unit tests without coupling tests to message builders. */
export function toEmbedJson(embed: EmbedBuilder): APIEmbed {
  return embed.toJSON();
}
