import { Client, ChannelType } from "discord.js";
import { formatError } from "../../helper/formatError";
import { BotLogChannelService } from "../BotLogChannelService";
import { CoCService } from "../CoCService";
import {
  buildFwaMatchChecklistRenderStateForGuild,
  type FwaMatchChecklistRenderState,
} from "../FwaMatchChecklistStateService";
import { publishFwaMatchChecklistMessageToChannel } from "../FwaMatchChecklistService";
import {
  resolveFwaMatchChecklistKindFromViewType,
  trackedMessageService,
} from "../TrackedMessageService";

type ChecklistViewType = "Mail" | "Bases";

type SyncTrackedMessageLike = {
  guildId: string;
  channelId: string;
  messageId: string;
  expiresAt?: Date | null;
  fallbackExpiresAt?: Date | null;
};

type ChecklistDestinationChannel = {
  id: string;
  type?: number;
  isTextBased?: () => boolean;
  send: Parameters<typeof publishFwaMatchChecklistMessageToChannel>[0]["channel"]["send"];
};

type CoCServiceFactory = () => CoCService;

const CHECKLIST_VIEW_TYPES: ChecklistViewType[] = ["Mail", "Bases"];
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

    let posted = 0;
    let skipped = 0;
    let failed = 0;
    const pendingPublications: Array<{
      viewType: ChecklistViewType;
      claim: {
        claimed: boolean;
        claimKey: string | null;
        sourceTrackedMessageId: string | null;
      };
    }> = [];
    for (const viewType of viewTypes) {
      const kind = resolveFwaMatchChecklistKindFromViewType(viewType);
      const claim = await trackedMessageService.claimFwaMatchChecklistPublication({
        guildId,
        syncMessageId,
        viewType,
      });
      if (!claim.claimed) {
        if (!claim.sourceTrackedMessageId) {
          failed += 1;
          console.error(
            `[fwa match checklist auto-post] event=post_failed guild=${guildId} sync_message=${syncMessageId} kind=${kind} reason=missing_source`,
          );
          continue;
        }
        skipped += 1;
        console.info(
          `[fwa match checklist auto-post] event=skipped_duplicate_claimed guild=${guildId} sync_message=${syncMessageId} kind=${kind}`,
        );
        continue;
      }

      const existingMessage = await trackedMessageService.findFwaMatchChecklistPublicationBySyncReference({
        guildId,
        syncMessageId,
        viewType,
      });
      if (existingMessage) {
        skipped += 1;
        console.info(
          `[fwa match checklist auto-post] event=skipped_existing_message guild=${guildId} sync_message=${syncMessageId} kind=${kind} message=${existingMessage.messageId}`,
        );
        continue;
      }

      pendingPublications.push({ viewType, claim });
    }

    if (pendingPublications.length === 0) {
      return { posted, skipped, failed };
    }

    const configuredChannelId = await this.botLogChannelService.getChannelIdForType(
      guildId,
      "checklist",
    );
    if (!configuredChannelId) {
      for (const publication of pendingPublications) {
        if (publication.claim.sourceTrackedMessageId && publication.claim.claimKey) {
          await trackedMessageService.releaseFwaMatchChecklistPublicationClaim({
            sourceTrackedMessageId: publication.claim.sourceTrackedMessageId,
            claimKey: publication.claim.claimKey,
          }).catch(() => undefined);
        }
      }
      skipped += pendingPublications.length;
      console.info(
        `[fwa match checklist auto-post] event=skipped_no_channel guild=${guildId} sync_message=${syncMessageId}`,
      );
      return { posted, skipped, failed };
    }

    const guild = await params.client.guilds.fetch(guildId).catch((err) => {
      console.error(
        `[fwa match checklist auto-post] event=guild_fetch_failed guild=${guildId} sync_message=${syncMessageId} error=${formatError(err)}`,
      );
      return null;
    });
    if (!guild) {
      for (const publication of pendingPublications) {
        if (publication.claim.sourceTrackedMessageId && publication.claim.claimKey) {
          await trackedMessageService.releaseFwaMatchChecklistPublicationClaim({
            sourceTrackedMessageId: publication.claim.sourceTrackedMessageId,
            claimKey: publication.claim.claimKey,
          }).catch(() => undefined);
        }
      }
      failed += pendingPublications.length;
      return { posted, skipped, failed };
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
      for (const publication of pendingPublications) {
        if (publication.claim.sourceTrackedMessageId && publication.claim.claimKey) {
          await trackedMessageService.releaseFwaMatchChecklistPublicationClaim({
            sourceTrackedMessageId: publication.claim.sourceTrackedMessageId,
            claimKey: publication.claim.claimKey,
          }).catch(() => undefined);
        }
      }
      failed += pendingPublications.length;
      return { posted, skipped, failed };
    }
    if (!isSupportedChecklistDestination(channel)) {
      console.error(
        `[fwa match checklist auto-post] event=channel_not_sendable guild=${guildId} configured_channel=${configuredChannelId} sync_message=${syncMessageId}`,
      );
      for (const publication of pendingPublications) {
        if (publication.claim.sourceTrackedMessageId && publication.claim.claimKey) {
          await trackedMessageService.releaseFwaMatchChecklistPublicationClaim({
            sourceTrackedMessageId: publication.claim.sourceTrackedMessageId,
            claimKey: publication.claim.claimKey,
          }).catch(() => undefined);
        }
      }
      failed += pendingPublications.length;
      return { posted, skipped, failed };
    }

    let cocService: CoCService | null = null;
    const getCocService = (): CoCService => {
      cocService ??= this.cocServiceFactory();
      return cocService;
    };
    for (const publication of pendingPublications) {
      const { viewType, claim } = publication;
      const kind = resolveFwaMatchChecklistKindFromViewType(viewType);
      let state: FwaMatchChecklistRenderState;
      try {
        state = await buildFwaMatchChecklistRenderStateForGuild({
          cocService: getCocService(),
          guildId,
          client: params.client,
          warLookupCache: new Map(),
          viewType,
          fallbackExpiresAt: params.tracked.fallbackExpiresAt ?? null,
        });
      } catch (err) {
        if (claim.sourceTrackedMessageId && claim.claimKey) {
          await trackedMessageService.releaseFwaMatchChecklistPublicationClaim({
            sourceTrackedMessageId: claim.sourceTrackedMessageId,
            claimKey: claim.claimKey,
          }).catch(() => undefined);
        }
        failed += 1;
        console.error(
          `[fwa match checklist auto-post] event=state_failed guild=${guildId} sync_message=${syncMessageId} kind=${kind} error=${formatError(err)}`,
        );
        continue;
      }

      const publishResult = await publishFwaMatchChecklistMessageToChannel({
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
      if (!publishResult.sent || !publishResult.messageId) {
        if (claim.sourceTrackedMessageId && claim.claimKey) {
          await trackedMessageService.releaseFwaMatchChecklistPublicationClaim({
            sourceTrackedMessageId: claim.sourceTrackedMessageId,
            claimKey: claim.claimKey,
          }).catch(() => undefined);
        }
        failed += 1;
        console.error(
          `[fwa match checklist auto-post] event=send_failed_claim_released guild=${guildId} sync_message=${syncMessageId} kind=${kind} channel=${configuredChannelId}`,
        );
        continue;
      }
      if (!publishResult.finalized) {
        failed += 1;
        console.error(
          `[fwa match checklist auto-post] event=send_failed_claim_retained guild=${guildId} sync_message=${syncMessageId} kind=${kind} channel=${configuredChannelId} message=${publishResult.messageId}`,
        );
        continue;
      }
      posted += 1;
      console.info(
        `[fwa match checklist auto-post] event=posted guild=${guildId} sync_message=${syncMessageId} kind=${kind} channel=${configuredChannelId} message=${publishResult.messageId}`,
      );
    }

    return { posted, skipped, failed };
  }
}

export const fwaMatchChecklistAutoPostService = new FwaMatchChecklistAutoPostService();
