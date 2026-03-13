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
  targets: string;
  reason: string;
  strictContext: string | null;
};

const FIELD_LIMIT = 1024;
const PAGE_CONTENT_LIMIT = 980;

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
function paginateBlocks(blocks: string[]): string[] {
  if (blocks.length === 0) return ["No entries."];
  const pages: string[] = [];
  let current = "";

  for (const rawBlock of blocks) {
    const block = String(rawBlock ?? "").trim();
    if (!block) continue;
    const next = current ? `${current}\n\n${block}` : block;
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
      targets: "No targets logged.",
      reason: "No details available.",
      strictContext: null,
    };
  }

  const separatorIndex = raw.indexOf(" : ");
  if (separatorIndex <= -1) {
    return {
      targets: raw,
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

  const targets = targetsRaw
    .split(",")
    .map((chunk) =>
      chunk
        .replace(/\(\s*([^)]*?)\s*\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" | ");

  return {
    targets: targets || "No targets logged.",
    reason: reasonParts[0] ?? "No details available.",
    strictContext: reasonParts.length > 1 ? reasonParts.slice(1).join(" | ") : null,
  };
}

/** Purpose: render one not-following issue into the required multi-line violation block. */
function renderViolationBlock(issue: WarComplianceIssue): string {
  const parsed = parseActualBehavior(issue.actualBehavior);
  const name = String(issue.playerName ?? "").trim() || "Unknown member";
  const pos = Number.isFinite(Number(issue.playerPosition))
    ? `#${Math.trunc(Number(issue.playerPosition))}`
    : "#?";
  const lines = [`${pos} ${name}`, `→ ${parsed.targets}`, parsed.reason];
  if (parsed.strictContext) {
    lines.push(parsed.strictContext);
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
  participantsCount: number;
  attacksCount: number;
  missedCount: number;
  violationCount: number;
}): string {
  return [
    `👥 Participants: ${input.participantsCount}`,
    `⚔️ Attacks Logged: ${input.attacksCount}`,
    "---",
    `❌ Missed Both Attacks: ${input.missedCount}`,
    `⚠️ Didn't Follow Plan: ${input.violationCount}`,
  ].join("\n");
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
  warId: number | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  participantsCount: number;
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
          participantsCount: input.participantsCount,
          attacksCount: input.attacksCount,
          missedCount: input.missedBoth.length,
          violationCount: input.violations.length,
        }),
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
  const missedPages = paginateBlocks(missedLines);
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
      warId: input.warId,
      expectedOutcome: input.expectedOutcome,
      warStartTime: input.warStartTime,
      warEndTime: input.warEndTime,
      participantsCount: input.participantsCount,
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
    warId: input.warId,
    expectedOutcome: input.expectedOutcome,
    warStartTime: input.warStartTime,
    warEndTime: input.warEndTime,
    participantsCount: input.participantsCount,
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
