import { ReminderTargetClanType, ReminderType } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "../../prisma";
import { resolveCurrentCwlSeasonKey } from "../CwlRegistryService";
import { normalizeClanTag } from "../PlayerLinkService";

const REMINDER_OFFSET_PRESETS_SECONDS = [
  15 * 60,
  30 * 60,
  45 * 60,
  60 * 60,
  2 * 60 * 60,
  3 * 60 * 60,
  4 * 60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
] as const;

export type ReminderClanOption = {
  value: string;
  clanTag: string;
  clanType: ReminderTargetClanType;
  name: string | null;
  description: string;
};

export type ReminderTargetDisplay = {
  clanTag: string;
  clanType: ReminderTargetClanType;
  name: string | null;
  label: string;
};

export type ReminderWithDetails = {
  id: string;
  guildId: string;
  type: ReminderType;
  channelId: string;
  isEnabled: boolean;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  offsetsSeconds: number[];
  targets: ReminderTargetDisplay[];
};

export type ReminderListRow = {
  id: string;
  type: ReminderType;
  channelId: string;
  isEnabled: boolean;
  offsetsSeconds: number[];
  targetCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type ReminderDraftRow = {
  id: string;
  guildId: string;
  type: ReminderType;
  channelId: string;
  isEnabled: boolean;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  offsetsSeconds: number[];
  targets: Array<{ clanTag: string; clanType: ReminderTargetClanType }>;
  persistedReminderId: string | null;
};

/** Purpose: parse `HhMm` reminder offsets into positive total seconds. */
export function parseReminderTimeLeftInput(input: string): number | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized) return null;
  const match = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const totalSeconds = Math.trunc(hours * 3600 + minutes * 60);
  if (totalSeconds <= 0) return null;
  return totalSeconds;
}

/** Purpose: parse comma-separated `HhMm` offsets into a normalized unique ascending list. */
export function parseReminderOffsetsInputList(input: string): number[] {
  const parts = String(input ?? "")
    .split(/[,\s;]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const normalized = new Set<number>();
  for (const part of parts) {
    const parsed = parseReminderTimeLeftInput(part);
    if (!parsed) continue;
    normalized.add(parsed);
  }
  return [...normalized].sort((a, b) => a - b);
}

/** Purpose: format one offset in seconds into compact `HhMm` text for embeds and rows. */
export function formatReminderOffsetSeconds(offsetSeconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(Number(offsetSeconds) || 0));
  const totalMinutes = Math.floor(safeSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

/** Purpose: expose one deterministic preset offset list for command select menus. */
export function getReminderOffsetPresetSeconds(): number[] {
  return [...REMINDER_OFFSET_PRESETS_SECONDS];
}

/** Purpose: encode reminder clan-target identity for select-menu round-trips. */
export function encodeReminderClanTargetValue(input: {
  clanType: ReminderTargetClanType;
  clanTag: string;
}): string {
  return `${input.clanType}|${input.clanTag}`;
}

/** Purpose: decode one select-menu clan-target value into validated normalized identity. */
export function decodeReminderClanTargetValue(
  input: string,
): { clanType: ReminderTargetClanType; clanTag: string } | null {
  const [rawType, rawTag] = String(input ?? "").split("|");
  const clanType =
    rawType === "FWA" || rawType === "CWL"
      ? (rawType as ReminderTargetClanType)
      : null;
  const clanTag = normalizeClanTag(rawTag ?? "");
  if (!clanType || !clanTag) return null;
  return { clanType, clanTag };
}

/** Purpose: keep reminder persistence and guild-scoped reads/writes in one service boundary. */
export class ReminderService {
  private readonly draftById = new Map<string, ReminderDraftRow>();

  /** Purpose: return selectable clan options from both FWA tracked and current-season CWL registries. */
  async listSelectableClanOptions(guildId: string): Promise<ReminderClanOption[]> {
    if (!guildId) return [];
    const season = resolveCurrentCwlSeasonKey();
    const [fwaRows, cwlRows] = await Promise.all([
      prisma.trackedClan.findMany({
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: { tag: true, name: true },
      }),
      prisma.cwlTrackedClan.findMany({
        where: { season },
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: { tag: true, name: true },
      }),
    ]);

    const options: ReminderClanOption[] = [];
    for (const row of fwaRows) {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) continue;
      options.push({
        value: encodeReminderClanTargetValue({
          clanType: ReminderTargetClanType.FWA,
          clanTag,
        }),
        clanTag,
        clanType: ReminderTargetClanType.FWA,
        name: sanitizeDisplayText(row.name),
        description: "FWA tracked clan",
      });
    }
    for (const row of cwlRows) {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) continue;
      options.push({
        value: encodeReminderClanTargetValue({
          clanType: ReminderTargetClanType.CWL,
          clanTag,
        }),
        clanTag,
        clanType: ReminderTargetClanType.CWL,
        name: sanitizeDisplayText(row.name),
        description: `CWL tracked clan (${season})`,
      });
    }

    const uniqueByValue = new Map<string, ReminderClanOption>();
    for (const option of options) {
      uniqueByValue.set(option.value, option);
    }
    return [...uniqueByValue.values()].sort((a, b) => {
      const typeSort = a.clanType.localeCompare(b.clanType);
      if (typeSort !== 0) return typeSort;
      const nameSort = (a.name ?? "").localeCompare(b.name ?? "");
      if (nameSort !== 0) return nameSort;
      return a.clanTag.localeCompare(b.clanTag);
    });
  }

  /** Purpose: create an in-memory reminder draft from optional slash seeds without persisting until save. */
  async createReminderDraft(input: {
    guildId: string;
    type?: ReminderType | null;
    channelId?: string | null;
    offsetSeconds?: number | null;
    offsetsSeconds?: number[] | null;
    actorUserId: string;
  }): Promise<ReminderWithDetails> {
    const normalizedOffsets = normalizeReminderOffsets([
      ...(Array.isArray(input.offsetsSeconds) ? input.offsetsSeconds : []),
      Number(input.offsetSeconds ?? 0),
    ]);
    const now = new Date();
    const draftId = `draft_${randomUUID()}`;
    const created: ReminderDraftRow = {
      id: draftId,
      guildId: input.guildId,
      type:
        input.type === ReminderType.WAR_CWL ||
        input.type === ReminderType.RAIDS ||
        input.type === ReminderType.GAMES
          ? input.type
          : ReminderType.EVENT,
      channelId: sanitizeDraftChannelId(input.channelId),
      isEnabled: false,
      createdByUserId: input.actorUserId,
      updatedByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
      offsetsSeconds: normalizedOffsets,
      targets: [],
      persistedReminderId: null,
    };
    this.draftById.set(draftId, created);
    console.log(
      `[reminders] action=draft_created reminder_id=${created.id} guild=${created.guildId} type=${created.type} channel=${created.channelId || "unset"} actor=${input.actorUserId}`,
    );
    return this.getReminderWithDetails({ reminderId: created.id, guildId: input.guildId });
  }

  /** Purpose: delete one reminder config with guild scoping and safe no-op semantics. */
  async deleteReminder(input: {
    reminderId: string;
    guildId: string;
    actorUserId: string;
  }): Promise<boolean> {
    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      this.draftById.delete(input.reminderId);
      console.log(
        `[reminders] action=draft_deleted reminder_id=${input.reminderId} guild=${input.guildId} actor=${input.actorUserId}`,
      );
      return true;
    }
    const deleted = await prisma.reminder.deleteMany({
      where: {
        id: input.reminderId,
        guildId: input.guildId,
      },
    });
    if (deleted.count > 0) {
      console.log(
        `[reminders] action=deleted reminder_id=${input.reminderId} guild=${input.guildId} actor=${input.actorUserId}`,
      );
    }
    return deleted.count > 0;
  }

  /** Purpose: enable/disable one reminder config with strict guild scoping. */
  async setReminderEnabled(input: {
    reminderId: string;
    guildId: string;
    isEnabled: boolean;
    actorUserId: string;
  }): Promise<void> {
    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      if (input.isEnabled) {
        const persisted = await this.createOrMergeReminder({
          guildId: input.guildId,
          type: draft.type,
          channelId: draft.channelId,
          offsetsSeconds: draft.offsetsSeconds,
          targets: draft.targets,
          actorUserId: input.actorUserId,
          isEnabled: true,
        });
        draft.persistedReminderId = persisted.id;
      } else {
        draft.isEnabled = false;
        draft.updatedByUserId = input.actorUserId;
        draft.updatedAt = new Date();
      }
      return;
    }
    await prisma.reminder.updateMany({
      where: {
        id: input.reminderId,
        guildId: input.guildId,
      },
      data: {
        isEnabled: input.isEnabled,
        updatedByUserId: input.actorUserId,
      },
    });
    console.log(
      `[reminders] action=enabled reminder_id=${input.reminderId} guild=${input.guildId} enabled=${input.isEnabled ? "1" : "0"} actor=${input.actorUserId}`,
    );
  }

  /** Purpose: update reminder type in-place for one guild-scoped reminder. */
  async setReminderType(input: {
    reminderId: string;
    guildId: string;
    type: ReminderType;
    actorUserId: string;
  }): Promise<void> {
    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      draft.type = input.type;
      draft.updatedByUserId = input.actorUserId;
      draft.updatedAt = new Date();
      return;
    }
    await prisma.reminder.updateMany({
      where: {
        id: input.reminderId,
        guildId: input.guildId,
      },
      data: {
        type: input.type,
        updatedByUserId: input.actorUserId,
      },
    });
    console.log(
      `[reminders] action=type_updated reminder_id=${input.reminderId} guild=${input.guildId} type=${input.type} actor=${input.actorUserId}`,
    );
  }

  /** Purpose: update reminder channel in-place for one guild-scoped reminder. */
  async setReminderChannel(input: {
    reminderId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
  }): Promise<void> {
    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      draft.channelId = sanitizeDraftChannelId(input.channelId);
      draft.updatedByUserId = input.actorUserId;
      draft.updatedAt = new Date();
      return;
    }
    await prisma.reminder.updateMany({
      where: {
        id: input.reminderId,
        guildId: input.guildId,
      },
      data: {
        channelId: input.channelId,
        updatedByUserId: input.actorUserId,
      },
    });
    console.log(
      `[reminders] action=channel_updated reminder_id=${input.reminderId} guild=${input.guildId} channel=${input.channelId} actor=${input.actorUserId}`,
    );
  }

  /** Purpose: replace one reminder's offsets atomically with normalized unique positive values. */
  async replaceReminderOffsets(input: {
    reminderId: string;
    guildId: string;
    offsetsSeconds: number[];
    actorUserId: string;
  }): Promise<number[]> {
    const normalized = normalizeReminderOffsets(input.offsetsSeconds);
    if (normalized.length <= 0) return [];

    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      draft.offsetsSeconds = normalized;
      draft.updatedByUserId = input.actorUserId;
      draft.updatedAt = new Date();
      return normalized;
    }

    await prisma.$transaction(async (tx) => {
      const ownsReminder = await tx.reminder.findFirst({
        where: {
          id: input.reminderId,
          guildId: input.guildId,
        },
        select: { id: true },
      });
      if (!ownsReminder) return;

      await tx.reminderTimeOffset.deleteMany({
        where: { reminderId: input.reminderId },
      });
      await tx.reminderTimeOffset.createMany({
        data: normalized.map((offsetSeconds) => ({
          reminderId: input.reminderId,
          offsetSeconds,
        })),
      });
      await tx.reminder.update({
        where: { id: input.reminderId },
        data: { updatedByUserId: input.actorUserId },
      });
    });
    console.log(
      `[reminders] action=offsets_updated reminder_id=${input.reminderId} guild=${input.guildId} offsets=${normalized.join(",")} actor=${input.actorUserId}`,
    );
    return normalized;
  }

  /** Purpose: replace one reminder's clan-target mapping atomically with normalized explicit target refs. */
  async replaceReminderTargets(input: {
    reminderId: string;
    guildId: string;
    targets: Array<{ clanTag: string; clanType: ReminderTargetClanType }>;
    actorUserId: string;
  }): Promise<number> {
    const normalizedTargets = dedupeReminderTargets(
      input.targets.map((target) => ({
        clanTag: normalizeClanTag(target.clanTag),
        clanType: target.clanType,
      })),
    );
    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      draft.targets = normalizedTargets;
      draft.updatedByUserId = input.actorUserId;
      draft.updatedAt = new Date();
      return normalizedTargets.length;
    }
    await prisma.$transaction(async (tx) => {
      const ownsReminder = await tx.reminder.findFirst({
        where: {
          id: input.reminderId,
          guildId: input.guildId,
        },
        select: { id: true },
      });
      if (!ownsReminder) return;

      await tx.reminderTargetClan.deleteMany({
        where: { reminderId: input.reminderId },
      });
      if (normalizedTargets.length > 0) {
        await tx.reminderTargetClan.createMany({
          data: normalizedTargets.map((target) => ({
            reminderId: input.reminderId,
            clanTag: target.clanTag,
            clanType: target.clanType,
          })),
        });
      }
      await tx.reminder.update({
        where: { id: input.reminderId },
        data: { updatedByUserId: input.actorUserId },
      });
    });
    console.log(
      `[reminders] action=targets_updated reminder_id=${input.reminderId} guild=${input.guildId} targets=${normalizedTargets.length} actor=${input.actorUserId}`,
    );
    return normalizedTargets.length;
  }

  /** Purpose: load one reminder with resolved offsets + target labels for embed rendering/edit UX. */
  async getReminderWithDetails(input: {
    reminderId: string;
    guildId: string;
  }): Promise<ReminderWithDetails> {
    const draft = this.draftById.get(input.reminderId);
    if (draft && draft.guildId === input.guildId) {
      if (draft.persistedReminderId) {
        const persistedReminderId = draft.persistedReminderId;
        this.draftById.delete(input.reminderId);
        return this.getReminderWithDetails({
          reminderId: persistedReminderId,
          guildId: input.guildId,
        });
      }
      const targets = await resolveReminderTargetDisplays(draft.targets);
      return {
        id: draft.id,
        guildId: draft.guildId,
        type: draft.type,
        channelId: draft.channelId,
        isEnabled: draft.isEnabled,
        createdByUserId: draft.createdByUserId,
        updatedByUserId: draft.updatedByUserId,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
        offsetsSeconds: [...draft.offsetsSeconds],
        targets,
      };
    }

    const reminder = await prisma.reminder.findFirst({
      where: {
        id: input.reminderId,
        guildId: input.guildId,
      },
      include: {
        times: {
          select: { offsetSeconds: true },
          orderBy: { offsetSeconds: "asc" },
        },
        targetClans: {
          select: { clanTag: true, clanType: true },
          orderBy: [{ clanType: "asc" }, { clanTag: "asc" }],
        },
      },
    });
    if (!reminder) {
      throw new Error("REMINDER_NOT_FOUND");
    }

    const targets = await resolveReminderTargetDisplays(reminder.targetClans);
    return {
      id: reminder.id,
      guildId: reminder.guildId,
      type: reminder.type,
      channelId: reminder.channelId,
      isEnabled: reminder.isEnabled,
      createdByUserId: reminder.createdByUserId,
      updatedByUserId: reminder.updatedByUserId,
      createdAt: reminder.createdAt,
      updatedAt: reminder.updatedAt,
      offsetsSeconds: reminder.times.map((time) => time.offsetSeconds),
      targets,
    };
  }

  /** Purpose: list guild-scoped reminder rows for admin list views with cheap aggregate metadata. */
  async listReminderSummariesForGuild(guildId: string): Promise<ReminderListRow[]> {
    const rows = await prisma.reminder.findMany({
      where: { guildId },
      include: {
        times: {
          select: { offsetSeconds: true },
          orderBy: { offsetSeconds: "asc" },
        },
        _count: {
          select: { targetClans: true },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      channelId: row.channelId,
      isEnabled: row.isEnabled,
      offsetsSeconds: row.times.map((time) => time.offsetSeconds),
      targetCount: row._count.targetClans,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /** Purpose: find reminders targeting one normalized clan tag for edit flow lookup/disambiguation. */
  async findReminderSummariesByClan(input: {
    guildId: string;
    clanTag: string;
  }): Promise<ReminderListRow[]> {
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return [];
    const rows = await prisma.reminder.findMany({
      where: {
        guildId: input.guildId,
        targetClans: {
          some: {
            clanTag,
          },
        },
      },
      include: {
        times: {
          select: { offsetSeconds: true },
          orderBy: { offsetSeconds: "asc" },
        },
        _count: {
          select: { targetClans: true },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      channelId: row.channelId,
      isEnabled: row.isEnabled,
      offsetsSeconds: row.times.map((time) => time.offsetSeconds),
      targetCount: row._count.targetClans,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /** Purpose: persist one final create-panel config, merging with an identical existing reminder when present. */
  private async createOrMergeReminder(input: {
    guildId: string;
    type: ReminderType;
    channelId: string;
    offsetsSeconds: number[];
    targets: Array<{ clanTag: string; clanType: ReminderTargetClanType }>;
    actorUserId: string;
    isEnabled: boolean;
  }): Promise<ReminderWithDetails> {
    const type =
      input.type === ReminderType.WAR_CWL ||
      input.type === ReminderType.RAIDS ||
      input.type === ReminderType.GAMES
        ? input.type
        : null;
    const channelId = sanitizeDraftChannelId(input.channelId);
    const offsetsSeconds = normalizeReminderOffsets(input.offsetsSeconds);
    const targets = dedupeReminderTargets(
      input.targets.map((target) => ({
        clanTag: normalizeClanTag(target.clanTag),
        clanType: target.clanType,
      })),
    );
    if (!type) {
      throw new Error("REMINDER_DRAFT_TYPE_REQUIRED");
    }
    if (!channelId) {
      throw new Error("REMINDER_DRAFT_CHANNEL_REQUIRED");
    }
    if (offsetsSeconds.length <= 0) {
      throw new Error("REMINDER_DRAFT_OFFSETS_REQUIRED");
    }
    if (targets.length <= 0) {
      throw new Error("REMINDER_DRAFT_TARGETS_REQUIRED");
    }

    const candidates = await prisma.reminder.findMany({
      where: {
        guildId: input.guildId,
        type,
        channelId,
      },
      include: {
        times: {
          select: { offsetSeconds: true },
          orderBy: { offsetSeconds: "asc" },
        },
        targetClans: {
          select: { clanTag: true, clanType: true },
          orderBy: [{ clanType: "asc" }, { clanTag: "asc" }],
        },
      },
    });
    const matchingExisting = candidates.find((row) => {
      const rowOffsets = normalizeReminderOffsets(row.times.map((time) => time.offsetSeconds));
      if (!areNumberListsEqual(rowOffsets, offsetsSeconds)) return false;
      const rowTargets = dedupeReminderTargets(
        row.targetClans.map((target) => ({
          clanTag: normalizeClanTag(target.clanTag),
          clanType: target.clanType,
        })),
      );
      return areReminderTargetListsEqual(rowTargets, targets);
    });
    if (matchingExisting) {
      await prisma.reminder.update({
        where: { id: matchingExisting.id },
        data: {
          isEnabled: input.isEnabled ? true : matchingExisting.isEnabled,
          updatedByUserId: input.actorUserId,
        },
      });
      console.log(
        `[reminders] action=merged_existing reminder_id=${matchingExisting.id} guild=${input.guildId} type=${type} channel=${channelId} actor=${input.actorUserId}`,
      );
      return this.getReminderWithDetails({
        reminderId: matchingExisting.id,
        guildId: input.guildId,
      });
    }

    const created = await prisma.reminder.create({
      data: {
        guildId: input.guildId,
        type,
        channelId,
        isEnabled: input.isEnabled,
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
        times: {
          create: offsetsSeconds.map((offsetSeconds) => ({ offsetSeconds })),
        },
        targetClans: {
          create: targets.map((target) => ({
            clanTag: target.clanTag,
            clanType: target.clanType,
          })),
        },
      },
    });
    console.log(
      `[reminders] action=created reminder_id=${created.id} guild=${input.guildId} type=${type} channel=${channelId} actor=${input.actorUserId}`,
    );
    return this.getReminderWithDetails({
      reminderId: created.id,
      guildId: input.guildId,
    });
  }

  /** Purpose: decode select-menu target values and persist the normalized reminder target set. */
  async replaceReminderTargetsFromEncodedValues(input: {
    reminderId: string;
    guildId: string;
    encodedValues: string[];
    actorUserId: string;
  }): Promise<number> {
    const allowedValues = new Set(
      (await this.listSelectableClanOptions(input.guildId)).map((option) => option.value),
    );
    const decoded = input.encodedValues
      .filter((value) => allowedValues.has(value))
      .map((value) => decodeReminderClanTargetValue(value))
      .filter(
        (target): target is { clanTag: string; clanType: ReminderTargetClanType } =>
          Boolean(target),
      );
    return this.replaceReminderTargets({
      reminderId: input.reminderId,
      guildId: input.guildId,
      targets: decoded,
      actorUserId: input.actorUserId,
    });
  }
}

/** Purpose: expose a singleton reminder service aligned with other command/service patterns. */
export const reminderService = new ReminderService();

/** Purpose: normalize optional text values for deterministic display use. */
function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/** Purpose: normalize optional draft channel input to a Discord snowflake or empty-string placeholder. */
function sanitizeDraftChannelId(input: unknown): string {
  const normalized = String(input ?? "").trim();
  if (!/^\d+$/.test(normalized)) return "";
  return normalized;
}

/** Purpose: normalize offset arrays into sorted unique positive integer seconds. */
function normalizeReminderOffsets(offsetsSeconds: number[]): number[] {
  return [
    ...new Set(
      offsetsSeconds
        .map((offset) => Math.trunc(Number(offset)))
        .filter((offset) => Number.isFinite(offset) && offset > 0),
    ),
  ].sort((a, b) => a - b);
}

/** Purpose: compare two sorted numeric lists with exact length/value matching. */
function areNumberListsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let idx = 0; idx < left.length; idx += 1) {
    if (left[idx] !== right[idx]) return false;
  }
  return true;
}

/** Purpose: dedupe normalized reminder target refs using clan-type + clan-tag identity. */
function dedupeReminderTargets(
  targets: Array<{ clanTag: string; clanType: ReminderTargetClanType }>,
): Array<{ clanTag: string; clanType: ReminderTargetClanType }> {
  const unique = new Map<string, { clanTag: string; clanType: ReminderTargetClanType }>();
  for (const target of targets) {
    if (!target.clanTag) continue;
    const key = `${target.clanType}|${target.clanTag}`;
    unique.set(key, {
      clanTag: target.clanTag,
      clanType: target.clanType,
    });
  }
  return [...unique.values()].sort((a, b) => {
    const typeSort = a.clanType.localeCompare(b.clanType);
    if (typeSort !== 0) return typeSort;
    return a.clanTag.localeCompare(b.clanTag);
  });
}

/** Purpose: compare normalized reminder target identity sets for merge detection. */
function areReminderTargetListsEqual(
  left: Array<{ clanTag: string; clanType: ReminderTargetClanType }>,
  right: Array<{ clanTag: string; clanType: ReminderTargetClanType }>,
): boolean {
  if (left.length !== right.length) return false;
  for (let idx = 0; idx < left.length; idx += 1) {
    if (left[idx]?.clanType !== right[idx]?.clanType) return false;
    if (left[idx]?.clanTag !== right[idx]?.clanTag) return false;
  }
  return true;
}

/** Purpose: resolve reminder target clan labels with source-aware names for FWA and seasonal CWL tags. */
async function resolveReminderTargetDisplays(
  targets: Array<{ clanTag: string; clanType: ReminderTargetClanType }>,
): Promise<ReminderTargetDisplay[]> {
  if (targets.length <= 0) return [];
  const season = resolveCurrentCwlSeasonKey();
  const fwaTags = [
    ...new Set(
      targets
        .filter((target) => target.clanType === ReminderTargetClanType.FWA)
        .map((target) => target.clanTag),
    ),
  ];
  const cwlTags = [
    ...new Set(
      targets
        .filter((target) => target.clanType === ReminderTargetClanType.CWL)
        .map((target) => target.clanTag),
    ),
  ];

  const [fwaRows, cwlRows] = await Promise.all([
    fwaTags.length > 0
      ? prisma.trackedClan.findMany({
          where: { tag: { in: fwaTags } },
          select: { tag: true, name: true },
        })
      : Promise.resolve([]),
    cwlTags.length > 0
      ? prisma.cwlTrackedClan.findMany({
          where: {
            season,
            tag: { in: cwlTags },
          },
          select: { tag: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const fwaNameByTag = new Map(
    fwaRows
      .map((row) => [normalizeClanTag(row.tag), sanitizeDisplayText(row.name)] as const)
      .filter((entry): entry is [string, string | null] => Boolean(entry[0])),
  );
  const cwlNameByTag = new Map(
    cwlRows
      .map((row) => [normalizeClanTag(row.tag), sanitizeDisplayText(row.name)] as const)
      .filter((entry): entry is [string, string | null] => Boolean(entry[0])),
  );

  return targets.map((target) => {
    const name =
      target.clanType === ReminderTargetClanType.FWA
        ? fwaNameByTag.get(target.clanTag) ?? null
        : cwlNameByTag.get(target.clanTag) ?? null;
    const sourceLabel =
      target.clanType === ReminderTargetClanType.FWA ? "FWA" : `CWL ${season}`;
    const clanLabel = name ? `${name} (${target.clanTag})` : target.clanTag;
    return {
      clanTag: target.clanTag,
      clanType: target.clanType,
      name,
      label: `${clanLabel} [${sourceLabel}]`,
    };
  });
}
