const PROD_BOT_ID = "1131335782016237749";
const STAGING_BOT_ID = "1474193888146358393";

export type SyncBadgeEmoji = { code: string; label: string; name: string; id: string };

const SYNC_BADGE_EMOJIS_BY_BOT: Record<string, SyncBadgeEmoji[]> = {
  [STAGING_BOT_ID]: [
    { code: "ZG", label: "ZERO GRAVITY", name: "zg", id: "1476279645174366449" },
    { code: "TWC", label: "TheWiseCowboys", name: "twc", id: "1476279643660091452" },
    { code: "SE", label: "Steel Empire 2", name: "se", id: "1476279635208573009" },
    { code: "RR", label: "Rocky Road", name: "rr", id: "1476279632729866242" },
    { code: "RD", label: "RISING DAWN", name: "rd", id: "1476279631345614902" },
    { code: "MV", label: "MARVELS", name: "mv", id: "1476279630129528986" },
    { code: "DE", label: "DARK EMPIRE™!", name: "de", id: "1476279629106118676" },
    { code: "AK", label: "ＡＫＡＴＳＵＫＩ", name: "ak", id: "1476279627839307836" },
  ],
  [PROD_BOT_ID]: [
    { code: "ZG", label: "ZERO GRAVITY", name: "zg", id: "1476279778670673930" },
    { code: "TWC", label: "TheWiseCowboys", name: "twc", id: "1476279777466908755" },
    { code: "SE", label: "Steel Empire 2", name: "se", id: "1476279774241493104" },
    { code: "RR", label: "Rocky Road", name: "rr", id: "1476279773243379762" },
    { code: "RD", label: "RISING DAWN", name: "rd", id: "1476279771884290100" },
    { code: "MV", label: "MARVELS", name: "mv", id: "1476279770667814932" },
    { code: "DE", label: "DARK EMPIRE™!", name: "de", id: "1476279769552392427" },
    { code: "AK", label: "ＡＫＡＴＳＵＫＩ", name: "ak", id: "1476279768608411874" },
  ],
};

function normalizeClanName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/["'`]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function getClanCodeFromName(value: string): string {
  const normalized = normalizeClanName(value);
  const map: Record<string, string> = {
    "RISING DAWN": "RD",
    "ZERO GRAVITY": "ZG",
    "DARK EMPIRE": "DE",
    "STEEL EMPIRE 2": "SE",
    "THEWISECOWBOYS": "TWC",
    MARVELS: "MV",
    "ROCKY ROAD": "RR",
    AKATSUKI: "AK",
  };
  return map[normalized] ?? normalized;
}

export function getSyncBadgeEmojis(botUserId: string | undefined): SyncBadgeEmoji[] {
  if (!botUserId) return [];
  return SYNC_BADGE_EMOJIS_BY_BOT[botUserId] ?? [];
}

export function getSyncBadgeEmojiIdentifiers(botUserId: string | undefined): string[] {
  return getSyncBadgeEmojis(botUserId).map((e) => `${e.name}:${e.id}`);
}

export function findSyncBadgeEmojiForClan(
  botUserId: string | undefined,
  clanName: string
): SyncBadgeEmoji | null {
  const badges = getSyncBadgeEmojis(botUserId);
  if (badges.length === 0) return null;
  const normalized = normalizeClanName(clanName);
  const code = getClanCodeFromName(clanName);
  return (
    badges.find((b) => normalizeClanName(b.label) === normalized) ??
    badges.find((b) => b.code.toUpperCase() === code.toUpperCase()) ??
    null
  );
}
