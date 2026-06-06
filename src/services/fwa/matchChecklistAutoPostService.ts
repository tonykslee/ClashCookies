import { Client, ChannelType } from "discord.js";
import { formatError } from "../../helper/formatError";
import { prisma } from "../../prisma";
import { BotLogChannelService } from "../BotLogChannelService";
import { CoCService } from "../CoCService";
import {
  buildFwaMatchChecklistRenderStateForGuild,
  type FwaMatchChecklistRenderState,
} from "../FwaMatchChecklistStateService";
import { publishFwaMatchChecklistMessageToChannel } from "../FwaMatchChecklistService";
import {
  parseFwaMatchChecklistMetadata,
  resolveFwaMatchChecklistViewType,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
} from "../TrackedMessageService";

type ChecklistViewType = "Mail" | "Bases";

type SyncTrackedMessageLike = {
  guildId: string;
  channelId: string;
  messageId: string;
  expiresAt?: Date | null;
};

type ChecklistDestinationChannel = {
  id: string;
  type?: number;
  isTextBased?: () => boolean;
  send: Parameters<typeof publishFwaMatchChecklistMessageToChannel>[0]["channel"]["send"];
};

type CoCServiceFactory = () => CoCService;

const CHECKLIST_VIEW_TYPES: ChecklistViewType[] = ["Mail", "Bases"];

function checklistKindForViewType(viewType: ChecklistViewType): "mail_checklist" | "bases_checklist" {
  return viewType === "Bases" ? "bases_checklist" : "mail_checklist";
}

function isSupportedChecklistDestination(
  channel: unknown,
): channel is ChecklistDestinationChannel {
  const candidate = channel as ChecklistDestinationChannel | null | undefined;
  if (!candidate || typeof candidate.send !== "function") return false;
  if (typeof candidate.isTextBased === "function" && !candidate.isTextBased()) return false;
  return (
    candidate.type === ChannelType.GuildText ||
    candidate.type === ChannelType.GuildAnnouncement
  );
}

async function hasChecklistForSyncReference(params: {
  guildId: string;
  syncMessageId: string;
  viewType: ChecklistViewType;
}): Promise<boolean> {
  const kind = checklistKindForViewType(params.viewType);
  const rows = await prisma.trackedMessage.findMany({
    where: {
      guildId: params.guildId,
      referenceId: params.syncMessageId,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
      status: {
        in: [
          TRACKED_MESSAGE_STATUS.ACTIVE,
          TRACKED_MESSAGE_STATUS.REPLACED,
          TRACKED_MESSAGE_STATUS.EXPIRED,
        ],
      },
    },
    select: { metadata: true },
  });
  return rows.some((row) => {
    const metadata = parseFwaMatchChecklistMetadata(row.metadata);
    return Boolean(metadata && resolveFwaMatchChecklistViewType(row.metadata) === params.viewType && metadata.kind === kind);
  });
}

export class FwaMatchChecklistAutoPostService {
  private readonly cocServiceFactory: CoCServiceFactory;

  constructor(
    private readonly botLogChannelService = new BotLogChannelService(),
    cocServiceOrFactory?: CoCService | CoCServiceFactory,
  ) {
    this.cocServiceFactory =
      typeof cocServiceOrFactory === "function"
        ? cocServiceOrFactory
        : () => cocServiceOrFactory ?? new CoCService();
  }

  async postForSyncTrackedMessage(params: {
    client: Client;
    tracked: SyncTrackedMessageLike;
    createdByUserId?: string | null;
    viewType?: ChecklistViewType;
  }): Promise<{ posted: number; skipped: number; failed: number }> {
    const guildId = String(params.tracked.guildId ?? "").trim();
    const syncMessageId = String(params.tracked.messageId ?? "").trim();
    if (!guildId || !syncMessageId) {
      const emptyCount = params.viewType ? 1 : CHECKLIST_VIEW_TYPES.length;
      return { posted: 0, skipped: emptyCount, failed: 0 };
    }

    const viewTypes = params.viewType ? [params.viewType] : CHECKLIST_VIEW_TYPES;

    const configuredChannelId = await this.botLogChannelService.getChannelIdForType(
      guildId,
      "checklist",
    );
    if (!configuredChannelId) {
      console.info(
        `[fwa match checklist auto-post] event=skipped_no_channel guild=${guildId} sync_message=${syncMessageId}`,
      );
      return { posted: 0, skipped: viewTypes.length, failed: 0 };
    }

    const guild = await params.client.guilds.fetch(guildId).catch((err) => {
      console.error(
        `[fwa match checklist auto-post] event=guild_fetch_failed guild=${guildId} sync_message=${syncMessageId} error=${formatError(err)}`,
      );
      return null;
    });
    if (!guild) {
      return { posted: 0, skipped: 0, failed: viewTypes.length };
    }

    let channelFetchFailed = false;
    const channel = await guild.channels.fetch(configuredChannelId).catch(async (err) => {
      const code = (err as { code?: number } | null | undefined)?.code;
      if (code === 10003) {
        await this.botLogChannelService.clearChannelIdForType(guildId, "checklist");
        console.error(
          `[fwa match checklist auto-post] event=stale_channel_cleared guild=${guildId} configured_channel=${configuredChannelId} sync_message=${syncMessageId} error=${formatError(err)}`,
        );
      } else {
        channelFetchFailed = true;
        console.error(
          `[fwa match checklist auto-post] event=channel_fetch_failed guild=${guildId} configured_channel=${configuredChannelId} sync_message=${syncMessageId} error=${formatError(err)}`,
        );
      }
      return null;
    });
    if (!channel) {
      if (!channelFetchFailed) {
        await this.botLogChannelService.clearChannelIdForType(guildId, "checklist");
        console.error(
          `[fwa match checklist auto-post] event=stale_channel_cleared guild=${guildId} configured_channel=${configuredChannelId} sync_message=${syncMessageId}`,
        );
      }
      return { posted: 0, skipped: 0, failed: viewTypes.length };
    }
    if (!isSupportedChecklistDestination(channel)) {
      console.error(
        `[fwa match checklist auto-post] event=channel_not_sendable guild=${guildId} configured_channel=${configuredChannelId} sync_message=${syncMessageId}`,
      );
      return { posted: 0, skipped: 0, failed: viewTypes.length };
    }

    let posted = 0;
    let skipped = 0;
    let failed = 0;
    let cocService: CoCService | null = null;
    const getCocService = (): CoCService => {
      cocService ??= this.cocServiceFactory();
      return cocService;
    };
    for (const viewType of viewTypes) {
      const kind = checklistKindForViewType(viewType);
      const duplicate = await hasChecklistForSyncReference({
        guildId,
        syncMessageId,
        viewType,
      });
      if (duplicate) {
        skipped += 1;
        console.info(
          `[fwa match checklist auto-post] event=skipped_duplicate guild=${guildId} sync_message=${syncMessageId} kind=${kind}`,
        );
        continue;
      }

      let state: FwaMatchChecklistRenderState;
      try {
        state = await buildFwaMatchChecklistRenderStateForGuild({
          cocService: getCocService(),
          guildId,
          client: params.client,
          warLookupCache: new Map(),
          viewType,
        });
      } catch (err) {
        failed += 1;
        console.error(
          `[fwa match checklist auto-post] event=state_failed guild=${guildId} sync_message=${syncMessageId} kind=${kind} error=${formatError(err)}`,
        );
        continue;
      }

      const messageId = await publishFwaMatchChecklistMessageToChannel({
        viewType,
        channel,
        guildId,
        channelId: configuredChannelId,
        rows: state.rows,
        clanTag: null,
        scopeKey: state.scopeKey,
        checkedClanTags: state.checkedClanTags,
        createdByUserId: String(params.createdByUserId ?? "system").trim() || "system",
        referenceId: syncMessageId,
        expiresAt: state.expiresAt ?? params.tracked.expiresAt ?? null,
      });
      if (!messageId) {
        failed += 1;
        console.error(
          `[fwa match checklist auto-post] event=post_failed guild=${guildId} sync_message=${syncMessageId} kind=${kind} channel=${configuredChannelId}`,
        );
        continue;
      }
      posted += 1;
      console.info(
        `[fwa match checklist auto-post] event=posted guild=${guildId} sync_message=${syncMessageId} kind=${kind} channel=${configuredChannelId} message=${messageId}`,
      );
    }

    return { posted, skipped, failed };
  }
}

export const fwaMatchChecklistAutoPostService = new FwaMatchChecklistAutoPostService();
