const FWA_MATCH_CHECKLIST_REFRESH_PREFIX = "fwa-match-checklist-refresh";
const FWA_COMPLIANCE_VIEW_PREFIX = "fwa-compliance-view";

export type FwaComplianceViewAction = "open_missed" | "open_main" | "prev" | "next";
export type FwaComplianceViewParams = {
  userId: string;
  key: string;
  action: FwaComplianceViewAction;
};

/** Purpose: build custom-id for checklist refresh button. */
export function buildFwaMatchChecklistRefreshCustomId(): string {
  return FWA_MATCH_CHECKLIST_REFRESH_PREFIX;
}

/** Purpose: parse checklist refresh custom-id payload. */
export function parseFwaMatchChecklistRefreshCustomId(customId: string): boolean {
  return customId === FWA_MATCH_CHECKLIST_REFRESH_PREFIX;
}

/** Purpose: detect checklist refresh button custom-id prefix. */
export function isFwaMatchChecklistRefreshButtonCustomId(customId: string): boolean {
  return customId === FWA_MATCH_CHECKLIST_REFRESH_PREFIX;
}

/** Purpose: build custom-id for /fwa compliance embed view buttons. */
export function buildFwaComplianceViewCustomId(params: FwaComplianceViewParams): string {
  return `${FWA_COMPLIANCE_VIEW_PREFIX}:${params.userId}:${params.key}:${params.action}`;
}

/** Purpose: parse /fwa compliance embed view button custom-id payload. */
export function parseFwaComplianceViewCustomId(
  customId: string,
): FwaComplianceViewParams | null {
  const values = parseCustomIdParts(customId, FWA_COMPLIANCE_VIEW_PREFIX, 4);
  if (!values) return null;
  const action: FwaComplianceViewAction | null =
    values[2] === "open_missed" ||
    values[2] === "open_main" ||
    values[2] === "prev" ||
    values[2] === "next"
      ? values[2]
      : null;
  if (!action) return null;
  return { userId: values[0], key: values[1], action };
}

/** Purpose: detect /fwa compliance embed view button custom-id prefix. */
export function isFwaComplianceViewButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_COMPLIANCE_VIEW_PREFIX}:`);
}

/** Purpose: parse a fixed custom-id format with prefix validation and non-empty parts. */
function parseCustomIdParts(
  customId: string,
  prefix: string,
  expectedParts: number,
): string[] | null {
  const parts = customId.split(":");
  if (parts.length !== expectedParts || parts[0] !== prefix) return null;
  const values = parts.slice(1).map((part) => part.trim());
  if (values.some((value) => !value)) return null;
  return values;
}
