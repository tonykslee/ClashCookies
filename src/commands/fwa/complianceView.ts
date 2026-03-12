import { type WarComplianceIssue, type WarComplianceReport } from "../../services/WarComplianceService";

/** Purpose: build a short member label for compliance output lines. */
function formatMemberLabel(issue: WarComplianceIssue): string {
  const tag = String(issue.playerTag ?? "").trim();
  const name = String(issue.playerName ?? "").trim() || tag || "Unknown member";
  if (!tag || tag === "UNKNOWN") return name;
  return `${name} (${tag})`;
}

/** Purpose: build compact not-following labels with participant position and no tag. */
function formatNotFollowingLabel(issue: WarComplianceIssue): string {
  const name = String(issue.playerName ?? "").trim() || "Unknown member";
  const posRaw = Number(issue.playerPosition ?? NaN);
  if (Number.isFinite(posRaw) && posRaw > 0) {
    return `#${Math.trunc(posRaw)}. ${name}`;
  }
  return name;
}

/** Purpose: format compliance issues into bounded output lines for Discord replies. */
function formatIssueLines(issues: WarComplianceIssue[], limit = 12): string[] {
  const visible = issues.slice(0, limit);
  const lines = visible.map((issue) => {
    const actual = String(issue.actualBehavior ?? "").trim() || "No details available.";
    if (issue.ruleType === "not_following_plan") {
      return `- ${formatNotFollowingLabel(issue)} --> ${actual}`;
    }
    return `- ${formatMemberLabel(issue)}: ${actual}`;
  });
  const hidden = issues.length - visible.length;
  if (hidden > 0) {
    lines.push(`- (+${hidden} more)`);
  }
  return lines;
}

/** Purpose: build deterministic user-facing `/fwa compliance` lines from report data. */
export function buildWarComplianceReportLines(input: {
  clanName: string;
  clanTag: string;
  report: WarComplianceReport;
}): string[] {
  const expectedLabel = input.report.expectedOutcome ?? "UNKNOWN";
  const headerName = String(input.clanName ?? "").trim() || `#${input.clanTag}`;
  const startedAt = Math.floor(input.report.warStartTime.getTime() / 1000);
  const endedAt =
    input.report.warEndTime instanceof Date
      ? `<t:${Math.floor(input.report.warEndTime.getTime() / 1000)}:R>`
      : "unknown";
  const lines: string[] = [
    `War compliance for **${headerName}** (#${input.clanTag})`,
    `War: **${input.report.warId ?? "unknown"}** | Started <t:${startedAt}:f> | Ended ${endedAt}`,
    `Match type: **${input.report.matchType ?? "UNKNOWN"}** | Expected outcome: **${expectedLabel}**`,
    `Participants: **${input.report.participantsCount}** | Attacks logged: **${input.report.attacksCount}**`,
    `Missed both attacks: **${input.report.missedBoth.length}**`,
    `Didn't follow plan: **${input.report.notFollowingPlan.length}**`,
  ];

  if (input.report.missedBoth.length === 0 && input.report.notFollowingPlan.length === 0) {
    lines.push("✅ Everyone followed the configured war plan.");
    return lines;
  }

  if (input.report.missedBoth.length > 0) {
    lines.push("");
    lines.push("Missed both attacks:");
    lines.push(...formatIssueLines(input.report.missedBoth));
  }

  if (input.report.notFollowingPlan.length > 0) {
    lines.push("");
    lines.push("Didn't follow war plan:");
    const expectedPlan = String(input.report.notFollowingPlan[0]?.expectedBehavior ?? "").trim();
    if (expectedPlan) {
      lines.push(`Expected: ${expectedPlan}`);
    }
    lines.push(...formatIssueLines(input.report.notFollowingPlan));
  }

  return lines;
}

