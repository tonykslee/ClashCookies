import { normalizeNicknameTemplate } from "./AutoRoleService";
import type { AutoRoleGuildConfigSnapshot } from "./AutoRoleEvaluationService";
import {
  getPlayerLinkTrustTier,
  isPlayerLinkVerifiedForAutorole,
  normalizeClanTag,
  type PlayerLinkWithTrust,
} from "./PlayerLinkService";
import type { PlayerCurrentLike } from "./PlayerCurrentService";

export { normalizeNicknameTemplate };

export type AutoRoleNicknameTrackedClanLike = {
  tag: string;
  name: string | null;
  shortName: string | null;
};

export type AutoRoleNicknameMemberLike = {
  id: string;
  displayName?: string | null;
  nickname?: string | null;
  user?: {
    username?: string | null;
    globalName?: string | null;
  } | null;
};

export type AutoRoleNicknameRenderInput = {
  config: AutoRoleGuildConfigSnapshot;
  template: string | null;
  member: AutoRoleNicknameMemberLike;
  linkedAccounts: PlayerLinkWithTrust[];
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  trackedClans: AutoRoleNicknameTrackedClanLike[];
};

export type AutoRoleNicknameRenderResult = {
  renderedNickname: string | null;
  primaryPlayerTag: string | null;
  primaryPlayerName: string | null;
  primaryClanTag: string | null;
  primaryClanName: string | null;
  primaryClanShort: string | null;
  trackedClans: string[];
};

export type AutoRoleNicknameCleanupResult = {
  cleanedNickname: string | null;
  removedSuffix: boolean;
};

type AutoRoleNicknameTokenName =
  | "player"
  | "tag"
  | "th"
  | "clan"
  | "clanTag"
  | "clanShort"
  | "trackedClans"
  | "discord"
  | "username"
  | "role";

type AutoRoleNicknameTokens = Record<AutoRoleNicknameTokenName, string>;
type AutoRoleNicknameTokenLookup = Record<string, string>;

type RankedNicknameAccount = PlayerLinkWithTrust & {
  playerCurrent: PlayerCurrentLike | null;
  trackedClan: NormalizedTrackedClan | null;
};

type NormalizedTrackedClan = {
  tag: string;
  name: string | null;
  shortName: string | null;
  label: string;
};

const TRUST_TIER_ORDER: Record<string, number> = {
  verified: 0,
  trusted: 1,
  legacy: 2,
  untrusted: 3,
  revoked: 4,
};

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTrackedClan(input: AutoRoleNicknameTrackedClanLike): NormalizedTrackedClan | null {
  const tag = normalizeClanTag(input.tag);
  if (!tag) {
    return null;
  }
  const shortName = normalizeText(input.shortName);
  const name = normalizeText(input.name);
  return {
    tag,
    shortName,
    name,
    label: shortName ?? name ?? tag,
  };
}

function isEligibleAutoroleLink(
  link: Pick<PlayerLinkWithTrust, "linkSource" | "verificationStatus" | "verificationMethod">,
  config: AutoRoleGuildConfigSnapshot,
): boolean {
  if (link.verificationStatus === "REVOKED") {
    return false;
  }

  if (config.verifiedOnlyMode || config.trustedLinksAllowed === false) {
    return isPlayerLinkVerifiedForAutorole(link);
  }

  return true;
}

function compareLinkedAccounts(left: RankedNicknameAccount, right: RankedNicknameAccount): number {
  const leftTracked = left.trackedClan ? 0 : 1;
  const rightTracked = right.trackedClan ? 0 : 1;
  if (leftTracked !== rightTracked) return leftTracked - rightTracked;

  const leftTh = left.playerCurrent?.townHall ?? -1;
  const rightTh = right.playerCurrent?.townHall ?? -1;
  if (leftTh !== rightTh) return rightTh - leftTh;

  const leftTier = TRUST_TIER_ORDER[getPlayerLinkTrustTier(left)] ?? 99;
  const rightTier = TRUST_TIER_ORDER[getPlayerLinkTrustTier(right)] ?? 99;
  if (leftTier !== rightTier) return leftTier - rightTier;

  const leftLinkedAt = left.createdAt?.getTime?.() ?? 0;
  const rightLinkedAt = right.createdAt?.getTime?.() ?? 0;
  if (leftLinkedAt !== rightLinkedAt) return leftLinkedAt - rightLinkedAt;

  return left.playerTag.localeCompare(right.playerTag);
}

function safeTruncate(input: string, maxLength: number): string {
  const chars = Array.from(input);
  if (chars.length <= maxLength) {
    return input;
  }
  return chars.slice(0, maxLength).join("").trimEnd().replace(/[|/-]\s*$/u, "").trimEnd();
}

function cleanNicknameOutput(input: string): string {
  let output = normalizeText(input) ?? "";
  if (!output) {
    return "";
  }

  output = output.replace(/\s*([|/-])\s*/g, " $1 ");
  output = output.replace(/\s{2,}/g, " ").trim();
  output = output.replace(/^(?:[|/-]\s*)+/g, "");
  output = output.replace(/(?:\s*[|/-])+\s*$/g, "");
  output = output.replace(/\s{2,}/g, " ").trim();

  return output;
}

function templateUsesDiscordTrackedClans(template: string): boolean {
  return /\{discord\}/i.test(template) && /\{trackedclans\}/i.test(template);
}

function normalizeTrackedClanLabel(input: string): string {
  return normalizeText(input)?.toLowerCase() ?? "";
}

const AUTOROLE_TRACKED_CLAN_SEPARATOR_RE = /\s+[|/-]\s+/g;

function buildConfiguredTrackedClanStripLabels(trackedClans: AutoRoleNicknameTrackedClanLike[]): string[] {
  const labels: string[] = [];
  for (const clan of trackedClans) {
    const normalized = normalizeTrackedClan(clan);
    if (!normalized) {
      continue;
    }

    if (normalized.shortName) {
      labels.push(normalized.shortName);
    }
    if (normalized.name) {
      labels.push(normalized.name);
    }
    if (!normalized.shortName && !normalized.name) {
      labels.push(normalized.tag);
    }
  }

  return [...new Set(labels.map((label) => normalizeText(label) ?? "").filter(Boolean))];
}

type TrackedClanSuffixRange = {
  start: number;
  end: number;
};

function findTrailingTrackedClanSuffixRange(
  input: string,
  trackedClanLabels: string[],
): TrackedClanSuffixRange | null {
  const normalizedInput = String(input ?? "");
  if (normalizedInput.trim().length === 0 || trackedClanLabels.length === 0) {
    return null;
  }

  const trackedLabelSet = new Set(
    trackedClanLabels.map((label) => normalizeTrackedClanLabel(label)).filter(Boolean),
  );
  if (trackedLabelSet.size === 0) {
    return null;
  }

  const segments: Array<{ start: number; end: number; text: string }> = [];
  const separatorRanges: Array<{ start: number; end: number }> = [];
  let segmentStart = 0;

  AUTOROLE_TRACKED_CLAN_SEPARATOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AUTOROLE_TRACKED_CLAN_SEPARATOR_RE.exec(normalizedInput)) !== null) {
    const separatorStart = match.index ?? 0;
    segments.push({
      start: segmentStart,
      end: separatorStart,
      text: normalizedInput.slice(segmentStart, separatorStart),
    });
    separatorRanges.push({
      start: separatorStart,
      end: separatorStart + match[0].length,
    });
    segmentStart = separatorStart + match[0].length;
  }
  AUTOROLE_TRACKED_CLAN_SEPARATOR_RE.lastIndex = 0;

  segments.push({
    start: segmentStart,
    end: normalizedInput.length,
    text: normalizedInput.slice(segmentStart),
  });

  let suffixStartIndex = segments.length;
  while (suffixStartIndex > 0) {
    const trailingLabel = normalizeTrackedClanLabel(segments[suffixStartIndex - 1].text);
    if (!trackedLabelSet.has(trailingLabel)) {
      break;
    }
    suffixStartIndex -= 1;
  }

  if (suffixStartIndex === segments.length) {
    return null;
  }

  if (suffixStartIndex === 0) {
    return {
      start: 0,
      end: normalizedInput.length,
    };
  }

  const separatorRange = separatorRanges[suffixStartIndex - 1] ?? null;
  if (!separatorRange) {
    return null;
  }

  return {
    start: separatorRange.start,
    end: normalizedInput.length,
  };
}

function stripTrailingTrackedClanLabels(input: string, trackedClanLabels: string[]): string {
  const normalized = normalizeText(input) ?? "";
  if (!normalized || trackedClanLabels.length === 0) {
    return normalized;
  }

  const suffixRange = findTrailingTrackedClanSuffixRange(normalized, trackedClanLabels);
  if (!suffixRange) {
    return normalized;
  }

  return normalized.slice(0, suffixRange.start).trimEnd();
}

/** Purpose: strip only trailing tracked-clan labels from a current server nickname. */
export function cleanupTrackedClanNickname(
  nickname: string | null | undefined,
  trackedClans: AutoRoleNicknameTrackedClanLike[],
): AutoRoleNicknameCleanupResult {
  const trimmedNickname = String(nickname ?? "").trim();
  if (!trimmedNickname) {
    return {
      cleanedNickname: null,
      removedSuffix: false,
    };
  }

  const suffixRange = findTrailingTrackedClanSuffixRange(
    trimmedNickname,
    buildConfiguredTrackedClanStripLabels(trackedClans),
  );
  if (!suffixRange) {
    return {
      cleanedNickname: trimmedNickname,
      removedSuffix: false,
    };
  }

  const strippedNickname = trimmedNickname.slice(0, suffixRange.start).trimEnd();
  return {
    cleanedNickname: strippedNickname.length > 0 ? strippedNickname : null,
    removedSuffix: true,
  };
}

function isMeaningfulNicknameOutput(input: string): boolean {
  return String(input ?? "")
    .replace(/[\p{P}\p{Z}]+/gu, "")
    .trim().length > 0;
}

function resolveTrackedClanLabel(clan: NormalizedTrackedClan): string {
  return clan.label;
}

function buildTrackedClanIndex(trackedClans: AutoRoleNicknameTrackedClanLike[]): Map<string, NormalizedTrackedClan> {
  const index = new Map<string, NormalizedTrackedClan>();
  for (const clan of trackedClans) {
    const normalized = normalizeTrackedClan(clan);
    if (!normalized || index.has(normalized.tag)) {
      continue;
    }
    index.set(normalized.tag, normalized);
  }
  return index;
}

/** Purpose: render autorole nickname templates from persisted linked-account and clan context without mutating Discord nicknames yet. */
export class AutoRoleNicknameService {
  renderNickname(input: AutoRoleNicknameRenderInput): AutoRoleNicknameRenderResult {
    const trackedClanIndex = buildTrackedClanIndex(input.trackedClans);
    const eligibleAccounts = [...input.linkedAccounts]
      .map((account) => ({
        ...account,
        playerCurrent: input.playerCurrentByTag.get(account.playerTag) ?? null,
        trackedClan: trackedClanIndex.get(
          normalizeClanTag(input.playerCurrentByTag.get(account.playerTag)?.currentClanTag ?? ""),
        ) ?? null,
      }))
      .filter((account) => account.playerTag.length > 0)
      .filter((account) => isEligibleAutoroleLink(account, input.config))
      .sort(compareLinkedAccounts);

    const primary = eligibleAccounts[0] ?? null;
    const primaryClan = primary?.trackedClan ?? null;
    const trackedClanLabels = this.buildTrackedClanLabels({
      accounts: eligibleAccounts,
      trackedClanIndex,
      primaryClanTag: primaryClan?.tag ?? null,
    });

    const primaryPlayerCurrent = primary ? primary.playerCurrent : null;
    const primaryPlayerTag = primary?.playerTag ?? null;
    const primaryPlayerName =
      normalizeText(primaryPlayerCurrent?.playerName) ?? 
      normalizeText(primary?.playerName) ?? 
      null;
    const primaryClanTag = primaryClan?.tag ?? primaryPlayerCurrent?.currentClanTag ?? null;
    const primaryClanName =
      normalizeText(primaryClan?.name) ??
      normalizeText(primaryPlayerCurrent?.currentClanName) ??
      null;
    const primaryClanShort = normalizeText(primaryClan?.shortName) ?? null;
    const template = normalizeNicknameTemplate(input.template) ?? "";
    const discordDisplayName = normalizeText(input.member.displayName ?? input.member.nickname ?? null) ?? "";
    const configuredTrackedClanStripLabels = buildConfiguredTrackedClanStripLabels(input.trackedClans);
    const discordToken = templateUsesDiscordTrackedClans(template)
      ? stripTrailingTrackedClanLabels(discordDisplayName, configuredTrackedClanStripLabels)
      : discordDisplayName;

    const tokens: AutoRoleNicknameTokens = {
      player: primaryPlayerName ?? "",
      tag: primaryPlayerTag ?? "",
      th: primaryPlayerCurrent?.townHall !== null && primaryPlayerCurrent?.townHall !== undefined
        ? String(primaryPlayerCurrent.townHall)
        : "",
      clan: primaryClanName ?? primaryClanShort ?? primaryClanTag ?? "",
      clanTag: primaryClanTag ?? "",
      clanShort: primaryClanShort ?? primaryClanName ?? primaryClanTag ?? "",
      trackedClans: trackedClanLabels.join(" | "),
      discord: discordToken,
      username: normalizeText(input.member.user?.username ?? input.member.user?.globalName ?? null) ?? "",
      role: normalizeText(primaryPlayerCurrent?.role ?? null) ?? "",
    };
    const tokenLookup: AutoRoleNicknameTokenLookup = {
      player: tokens.player,
      tag: tokens.tag,
      th: tokens.th,
      clan: tokens.clan,
      clantag: tokens.clanTag,
      clanshort: tokens.clanShort,
      trackedclans: tokens.trackedClans,
      discord: tokens.discord,
      username: tokens.username,
      role: tokens.role,
    };

    const rendered = template ? this.renderTemplate(template, tokenLookup) : "";
    const cleaned = cleanNicknameOutput(rendered);
    if (!cleaned || !isMeaningfulNicknameOutput(cleaned)) {
      return {
        renderedNickname: null,
        primaryPlayerTag,
        primaryPlayerName,
        primaryClanTag,
        primaryClanName,
        primaryClanShort,
        trackedClans: trackedClanLabels,
      };
    }

    const truncated = safeTruncate(cleaned, 32);
    if (!isMeaningfulNicknameOutput(truncated)) {
      return {
        renderedNickname: null,
        primaryPlayerTag,
        primaryPlayerName,
        primaryClanTag,
        primaryClanName,
        primaryClanShort,
        trackedClans: trackedClanLabels,
      };
    }

    return {
      renderedNickname: truncated.length > 0 ? truncated : null,
      primaryPlayerTag,
      primaryPlayerName,
      primaryClanTag,
      primaryClanName,
      primaryClanShort,
      trackedClans: trackedClanLabels,
    };
  }

  private renderTemplate(template: string, tokens: AutoRoleNicknameTokenLookup): string {
    return template.replace(/\{([a-zA-Z]+)\}/g, (match, tokenName) => {
      const token = tokenName.toLowerCase();
      return Object.prototype.hasOwnProperty.call(tokens, token) ? tokens[token] : match;
    });
  }

  private buildTrackedClanLabels(input: {
    accounts: RankedNicknameAccount[];
    trackedClanIndex: Map<string, NormalizedTrackedClan>;
    primaryClanTag: string | null;
  }): string[] {
    const tags = new Set<string>();
    for (const account of input.accounts) {
      const currentClanTag = normalizeClanTag(account.playerCurrent?.currentClanTag ?? "");
      if (currentClanTag && input.trackedClanIndex.has(currentClanTag)) {
        tags.add(currentClanTag);
      }
    }

    const labels = [...tags]
      .map((tag) => input.trackedClanIndex.get(tag)!)
      .filter(Boolean);
    labels.sort((left, right) => {
      const leftLabel = resolveTrackedClanLabel(left).toLowerCase();
      const rightLabel = resolveTrackedClanLabel(right).toLowerCase();
      if (leftLabel !== rightLabel) return leftLabel.localeCompare(rightLabel);
      return left.tag.localeCompare(right.tag);
    });

    const primary = input.primaryClanTag ? input.trackedClanIndex.get(input.primaryClanTag) ?? null : null;
    const ordered = primary ? [primary, ...labels.filter((clan) => clan.tag !== primary.tag)] : labels;
    const deduped: NormalizedTrackedClan[] = [];
    const seen = new Set<string>();
    for (const clan of ordered) {
      if (seen.has(clan.tag)) continue;
      seen.add(clan.tag);
      deduped.push(clan);
    }

    return deduped.map(resolveTrackedClanLabel);
  }
}

export const autoRoleNicknameService = new AutoRoleNicknameService();
