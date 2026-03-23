const POINTS_POST_BUTTON_PREFIX = "points-post-channel";
const FWA_MATCH_COPY_BUTTON_PREFIX = "fwa-match-copy";
const FWA_MATCH_TYPE_ACTION_PREFIX = "fwa-match-type-action";
const FWA_MATCH_TYPE_EDIT_PREFIX = "fwa-match-type-edit";
const FWA_OUTCOME_ACTION_PREFIX = "fwa-outcome-action";
const FWA_MATCH_SYNC_ACTION_PREFIX = "fwa-match-sync-action";
const FWA_MATCH_SKIP_SYNC_ACTION_PREFIX = "fwa-match-skip-sync-action";
const FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX = "fwa-match-skip-sync-confirm";
const FWA_MATCH_SKIP_SYNC_UNDO_PREFIX = "fwa-match-skip-sync-undo";
const FWA_MATCH_SELECT_PREFIX = "fwa-match-select";
const FWA_MATCH_ALLIANCE_PREFIX = "fwa-match-alliance";
const FWA_MAIL_CONFIRM_PREFIX = "fwa-mail-confirm";
const FWA_MAIL_CONFIRM_NO_PING_PREFIX = "fwa-mail-confirm-no-ping";
const FWA_MAIL_BACK_PREFIX = "fwa-mail-back";
const FWA_MAIL_REFRESH_PREFIX = "fwa-mail-refresh";
const FWA_MATCH_SEND_MAIL_PREFIX = "fwa-match-send-mail";
const FWA_MATCH_TIEBREAKER_PREFIX = "fwa-match-tiebreaker";
const FWA_COMPLIANCE_VIEW_PREFIX = "fwa-compliance-view";
const FWA_BASE_SWAP_SPLIT_POST_PREFIX = "fwa-base-swap-split-post";

export type MatchTypeActionParams = {
  userId: string;
  tag: string;
  targetType: "FWA" | "BL" | "MM";
};

export type MatchTypeEditParams = {
  userId: string;
  key: string;
};

export type OutcomeActionParams = {
  userId: string;
  tag: string;
  currentOutcome: "WIN" | "LOSE";
};

export type MatchSyncActionParams = {
  userId: string;
  key: string;
  tag: string;
};

export type MatchSkipSyncActionParams = {
  userId: string;
  key: string;
  tag: string;
};

export type FwaMatchTieBreakerParams = {
  userId: string;
  key: string;
  tag: string;
};

export type FwaComplianceViewAction = "open_missed" | "open_main" | "prev" | "next";
export type FwaComplianceViewParams = {
  userId: string;
  key: string;
  action: FwaComplianceViewAction;
};

export type FwaBaseSwapSplitPostAction = "yes" | "cancel";
export type FwaBaseSwapSplitPostParams = {
  userId: string;
  key: string;
  action: FwaBaseSwapSplitPostAction;
};

/** Purpose: normalize incoming clan tags to the internal uppercase/hashless form. */
function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

/** Purpose: parse a fixed custom-id format with prefix validation and non-empty parts. */
function parseCustomIdParts(
  customId: string,
  prefix: string,
  expectedParts: number
): string[] | null {
  const parts = customId.split(":");
  if (parts.length !== expectedParts || parts[0] !== prefix) return null;
  const values = parts.slice(1).map((part) => part.trim());
  if (values.some((value) => !value)) return null;
  return values;
}

/** Purpose: generate an opaque short-lived key for interaction payload maps. */
export function createTransientFwaKey(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Purpose: build custom-id for posting points output into a channel. */
export function buildPointsPostButtonCustomId(userId: string): string {
  return `${POINTS_POST_BUTTON_PREFIX}:${userId}`;
}

/** Purpose: parse points-post button custom-id payload. */
export function parsePointsPostButtonCustomId(customId: string): { userId: string } | null {
  const values = parseCustomIdParts(customId, POINTS_POST_BUTTON_PREFIX, 2);
  if (!values) return null;
  return { userId: values[0] };
}

/** Purpose: detect points-post button custom-id prefix. */
export function isPointsPostButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${POINTS_POST_BUTTON_PREFIX}:`);
}

/** Purpose: build custom-id for copy/embed toggle button in fwa match results. */
export function buildFwaMatchCopyCustomId(
  userId: string,
  key: string,
  mode: "copy" | "embed"
): string {
  return `${FWA_MATCH_COPY_BUTTON_PREFIX}:${userId}:${key}:${mode}`;
}

/** Purpose: parse fwa match copy-toggle custom-id payload. */
export function parseFwaMatchCopyCustomId(
  customId: string
): { userId: string; key: string; mode: "copy" | "embed" } | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_COPY_BUTTON_PREFIX, 4);
  if (!values) return null;
  const [userId, key, rawMode] = values;
  const mode = rawMode === "copy" || rawMode === "embed" ? rawMode : null;
  if (!mode) return null;
  return { userId, key, mode };
}

/** Purpose: detect fwa match copy-toggle button custom-id prefix. */
export function isFwaMatchCopyButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_COPY_BUTTON_PREFIX}:`);
}

/** Purpose: build custom-id for fwa match clan selector menu. */
export function buildFwaMatchSelectCustomId(userId: string, key: string): string {
  return `${FWA_MATCH_SELECT_PREFIX}:${userId}:${key}`;
}

/** Purpose: parse fwa match clan selector custom-id payload. */
export function parseFwaMatchSelectCustomId(customId: string): { userId: string; key: string } | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_SELECT_PREFIX, 3);
  if (!values) return null;
  return { userId: values[0], key: values[1] };
}

/** Purpose: detect fwa match selector custom-id prefix. */
export function isFwaMatchSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SELECT_PREFIX}:`);
}

/** Purpose: build custom-id for fwa match alliance-view button. */
export function buildFwaMatchAllianceCustomId(userId: string, key: string): string {
  return `${FWA_MATCH_ALLIANCE_PREFIX}:${userId}:${key}`;
}

/** Purpose: parse fwa match alliance-view custom-id payload. */
export function parseFwaMatchAllianceCustomId(customId: string): { userId: string; key: string } | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_ALLIANCE_PREFIX, 3);
  if (!values) return null;
  return { userId: values[0], key: values[1] };
}

/** Purpose: detect fwa match alliance-view button custom-id prefix. */
export function isFwaMatchAllianceButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_ALLIANCE_PREFIX}:`);
}

/** Purpose: build custom-id for match-type override action button. */
export function buildMatchTypeActionCustomId(params: MatchTypeActionParams): string {
  return `${FWA_MATCH_TYPE_ACTION_PREFIX}:${params.userId}:${normalizeTag(params.tag)}:${params.targetType}`;
}

/** Purpose: parse match-type override action custom-id payload. */
export function parseMatchTypeActionCustomId(customId: string): MatchTypeActionParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_TYPE_ACTION_PREFIX, 4);
  if (!values) return null;
  const [userId, rawTag, rawTargetType] = values;
  const targetType = rawTargetType === "FWA" || rawTargetType === "BL" || rawTargetType === "MM"
    ? rawTargetType
    : null;
  if (!targetType) return null;
  return { userId, tag: normalizeTag(rawTag), targetType };
}

/** Purpose: detect match-type override action button prefix. */
export function isFwaMatchTypeActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_TYPE_ACTION_PREFIX}:`);
}

/** Purpose: build custom-id for match-type edit entry button. */
export function buildMatchTypeEditCustomId(params: MatchTypeEditParams): string {
  return `${FWA_MATCH_TYPE_EDIT_PREFIX}:${params.userId}:${params.key}`;
}

/** Purpose: parse match-type edit entry custom-id payload. */
export function parseMatchTypeEditCustomId(customId: string): MatchTypeEditParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_TYPE_EDIT_PREFIX, 3);
  if (!values) return null;
  return { userId: values[0], key: values[1] };
}

/** Purpose: detect match-type edit entry button prefix. */
export function isFwaMatchTypeEditButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_TYPE_EDIT_PREFIX}:`);
}

/** Purpose: build custom-id for expected-outcome action button. */
export function buildOutcomeActionCustomId(params: OutcomeActionParams): string {
  return `${FWA_OUTCOME_ACTION_PREFIX}:${params.userId}:${normalizeTag(params.tag)}:${params.currentOutcome}`;
}

/** Purpose: parse expected-outcome action custom-id payload. */
export function parseOutcomeActionCustomId(customId: string): OutcomeActionParams | null {
  const values = parseCustomIdParts(customId, FWA_OUTCOME_ACTION_PREFIX, 4);
  if (!values) return null;
  const [userId, rawTag, rawOutcome] = values;
  const currentOutcome = rawOutcome === "WIN" || rawOutcome === "LOSE" ? rawOutcome : null;
  if (!currentOutcome) return null;
  return { userId, tag: normalizeTag(rawTag), currentOutcome };
}

/** Purpose: detect expected-outcome action button prefix. */
export function isFwaOutcomeActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_OUTCOME_ACTION_PREFIX}:`);
}

/** Purpose: build custom-id for sync data action button. */
export function buildMatchSyncActionCustomId(params: MatchSyncActionParams): string {
  return `${FWA_MATCH_SYNC_ACTION_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

/** Purpose: parse sync data action custom-id payload. */
export function parseMatchSyncActionCustomId(customId: string): MatchSyncActionParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_SYNC_ACTION_PREFIX, 4);
  if (!values) return null;
  return { userId: values[0], key: values[1], tag: normalizeTag(values[2]) };
}

/** Purpose: detect sync data action button prefix. */
export function isFwaMatchSyncActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SYNC_ACTION_PREFIX}:`);
}

/** Purpose: build custom-id for skip-sync action button. */
export function buildMatchSkipSyncActionCustomId(params: MatchSkipSyncActionParams): string {
  return `${FWA_MATCH_SKIP_SYNC_ACTION_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

/** Purpose: parse skip-sync action custom-id payload. */
export function parseMatchSkipSyncActionCustomId(customId: string): MatchSkipSyncActionParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_SKIP_SYNC_ACTION_PREFIX, 4);
  if (!values) return null;
  return { userId: values[0], key: values[1], tag: normalizeTag(values[2]) };
}

/** Purpose: detect skip-sync action button prefix. */
export function isFwaMatchSkipSyncActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SKIP_SYNC_ACTION_PREFIX}:`);
}

/** Purpose: build custom-id for skip-sync confirmation button. */
export function buildMatchSkipSyncConfirmCustomId(params: MatchSkipSyncActionParams): string {
  return `${FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

/** Purpose: parse skip-sync confirmation custom-id payload. */
export function parseMatchSkipSyncConfirmCustomId(customId: string): MatchSkipSyncActionParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX, 4);
  if (!values) return null;
  return { userId: values[0], key: values[1], tag: normalizeTag(values[2]) };
}

/** Purpose: detect skip-sync confirmation button prefix. */
export function isFwaMatchSkipSyncConfirmButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX}:`);
}

/** Purpose: build custom-id for skip-sync undo button. */
export function buildMatchSkipSyncUndoCustomId(params: MatchSkipSyncActionParams): string {
  return `${FWA_MATCH_SKIP_SYNC_UNDO_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

/** Purpose: parse skip-sync undo custom-id payload. */
export function parseMatchSkipSyncUndoCustomId(customId: string): MatchSkipSyncActionParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_SKIP_SYNC_UNDO_PREFIX, 4);
  if (!values) return null;
  return { userId: values[0], key: values[1], tag: normalizeTag(values[2]) };
}

/** Purpose: detect skip-sync undo button prefix. */
export function isFwaMatchSkipSyncUndoButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SKIP_SYNC_UNDO_PREFIX}:`);
}

/** Purpose: build custom-id for war-mail send confirmation button. */
export function buildFwaMailConfirmCustomId(userId: string, key: string): string {
  return `${FWA_MAIL_CONFIRM_PREFIX}:${userId}:${key}`;
}

/** Purpose: parse war-mail send confirmation custom-id payload. */
export function parseFwaMailConfirmCustomId(customId: string): { userId: string; key: string } | null {
  const values = parseCustomIdParts(customId, FWA_MAIL_CONFIRM_PREFIX, 3);
  if (!values) return null;
  return { userId: values[0], key: values[1] };
}

/** Purpose: detect war-mail send confirmation button prefix. */
export function isFwaMailConfirmButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MAIL_CONFIRM_PREFIX}:`);
}

/** Purpose: build custom-id for no-ping mail confirmation button. */
export function buildFwaMailConfirmNoPingCustomId(userId: string, key: string): string {
  return `${FWA_MAIL_CONFIRM_NO_PING_PREFIX}:${userId}:${key}`;
}

/** Purpose: parse no-ping mail confirmation custom-id payload. */
export function parseFwaMailConfirmNoPingCustomId(
  customId: string
): { userId: string; key: string } | null {
  const values = parseCustomIdParts(customId, FWA_MAIL_CONFIRM_NO_PING_PREFIX, 3);
  if (!values) return null;
  return { userId: values[0], key: values[1] };
}

/** Purpose: detect no-ping mail confirmation button prefix. */
export function isFwaMailConfirmNoPingButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MAIL_CONFIRM_NO_PING_PREFIX}:`);
}

/** Purpose: build custom-id for returning from mail preview to match view. */
export function buildFwaMailBackCustomId(userId: string, key: string): string {
  return `${FWA_MAIL_BACK_PREFIX}:${userId}:${key}`;
}

/** Purpose: parse back-to-match custom-id payload. */
export function parseFwaMailBackCustomId(customId: string): { userId: string; key: string } | null {
  const values = parseCustomIdParts(customId, FWA_MAIL_BACK_PREFIX, 3);
  if (!values) return null;
  return { userId: values[0], key: values[1] };
}

/** Purpose: detect back-to-match button prefix. */
export function isFwaMailBackButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MAIL_BACK_PREFIX}:`);
}

/** Purpose: build custom-id for manual war-mail refresh button. */
export function buildFwaMailRefreshCustomId(key: string): string {
  return `${FWA_MAIL_REFRESH_PREFIX}:${key}`;
}

/** Purpose: parse manual war-mail refresh custom-id payload. */
export function parseFwaMailRefreshCustomId(customId: string): { key: string } | null {
  const values = parseCustomIdParts(customId, FWA_MAIL_REFRESH_PREFIX, 2);
  if (!values) return null;
  return { key: values[0] };
}

/** Purpose: detect manual war-mail refresh button prefix. */
export function isFwaMailRefreshButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MAIL_REFRESH_PREFIX}:`);
}

/** Purpose: build custom-id for sending war-mail from the /fwa match card. */
export function buildFwaMatchSendMailCustomId(userId: string, key: string, tag: string): string {
  return `${FWA_MATCH_SEND_MAIL_PREFIX}:${userId}:${key}:${tag}`;
}

/** Purpose: parse send-mail-from-match custom-id payload. */
export function parseFwaMatchSendMailCustomId(
  customId: string
): { userId: string; key: string; tag: string } | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_SEND_MAIL_PREFIX, 4);
  if (!values) return null;
  return { userId: values[0], key: values[1], tag: normalizeTag(values[2]) };
}

/** Purpose: detect send-mail-from-match button prefix. */
export function isFwaMatchSendMailButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SEND_MAIL_PREFIX}:`);
}

/** Purpose: build custom-id for single-clan tie-breaker rules button. */
export function buildFwaMatchTieBreakerCustomId(
  params: FwaMatchTieBreakerParams,
): string {
  return `${FWA_MATCH_TIEBREAKER_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

/** Purpose: parse single-clan tie-breaker rules button custom-id payload. */
export function parseFwaMatchTieBreakerCustomId(
  customId: string,
): FwaMatchTieBreakerParams | null {
  const values = parseCustomIdParts(customId, FWA_MATCH_TIEBREAKER_PREFIX, 4);
  if (!values) return null;
  return { userId: values[0], key: values[1], tag: normalizeTag(values[2]) };
}

/** Purpose: detect single-clan tie-breaker rules button prefix. */
export function isFwaMatchTieBreakerButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_TIEBREAKER_PREFIX}:`);
}

/** Purpose: build custom-id for /fwa compliance embed view buttons. */
export function buildFwaComplianceViewCustomId(params: FwaComplianceViewParams): string {
  return `${FWA_COMPLIANCE_VIEW_PREFIX}:${params.userId}:${params.key}:${params.action}`;
}

/** Purpose: parse /fwa compliance embed view button custom-id payload. */
export function parseFwaComplianceViewCustomId(
  customId: string
): FwaComplianceViewParams | null {
  const values = parseCustomIdParts(customId, FWA_COMPLIANCE_VIEW_PREFIX, 4);
  if (!values) return null;
  const [userId, key, rawAction] = values;
  const action: FwaComplianceViewAction | null =
    rawAction === "open_missed" ||
    rawAction === "open_main" ||
    rawAction === "prev" ||
    rawAction === "next"
      ? rawAction
      : null;
  if (!action) return null;
  return { userId, key, action };
}

/** Purpose: detect /fwa compliance embed view button custom-id prefix. */
export function isFwaComplianceViewButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_COMPLIANCE_VIEW_PREFIX}:`);
}

/** Purpose: build custom-id for oversize base-swap split-post confirmation buttons. */
export function buildFwaBaseSwapSplitPostCustomId(
  params: FwaBaseSwapSplitPostParams,
): string {
  return `${FWA_BASE_SWAP_SPLIT_POST_PREFIX}:${params.userId}:${params.key}:${params.action}`;
}

/** Purpose: parse base-swap split-post confirmation custom-id payload. */
export function parseFwaBaseSwapSplitPostCustomId(
  customId: string,
): FwaBaseSwapSplitPostParams | null {
  const values = parseCustomIdParts(customId, FWA_BASE_SWAP_SPLIT_POST_PREFIX, 4);
  if (!values) return null;
  const [userId, key, rawAction] = values;
  const action: FwaBaseSwapSplitPostAction | null =
    rawAction === "yes" || rawAction === "cancel" ? rawAction : null;
  if (!action) return null;
  return { userId, key, action };
}

/** Purpose: detect base-swap split-post confirmation button prefix. */
export function isFwaBaseSwapSplitPostButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_BASE_SWAP_SPLIT_POST_PREFIX}:`);
}
