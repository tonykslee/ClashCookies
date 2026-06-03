import { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { formatError } from "../helper/formatError";
import { FWA_BASE_SWAP_ACK_EMOJI, handleFwaBaseSwapReaction } from "../commands/Fwa";
import {
  trackedMessageService,
  TRACKED_MESSAGE_FEATURE_TYPE,
  resolveFwaMatchChecklistViewType,
} from "../services/TrackedMessageService";

let isRegistered = false;

async function materializeReaction(
  reaction: MessageReaction | PartialMessageReaction,
): Promise<MessageReaction | null> {
  if (reaction.partial) {
    try {
      return await reaction.fetch();
    } catch {
      return null;
    }
  }
  return reaction;
}

async function materializeUser(user: User | PartialUser): Promise<User | null> {
  if (user.partial) {
    try {
      return await user.fetch();
    } catch {
      return null;
    }
  }
  return user;
}

export default (client: Client): void => {
  if (isRegistered) {
    console.warn("messageReactionAdd already registered, skipping");
    return;
  }

  isRegistered = true;

  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const fullReaction = await materializeReaction(reaction);
      const fullUser = await materializeUser(user);
      if (!fullReaction || !fullUser) {
        return;
      }
      const tracked = await trackedMessageService.getActiveByMessageId(fullReaction.message.id);
      const isChecklist =
        tracked?.status === "ACTIVE" &&
        tracked.featureType === TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST;
      if (isChecklist) {
        console.debug(
          `[fwa_checklist_reaction_received] guildId=${tracked.guildId} messageId=${fullReaction.message.id} featureType=${tracked.featureType} viewType=${resolveFwaMatchChecklistViewType(tracked.metadata)} emojiId=${fullReaction.emoji.id ?? "none"} emojiName=${fullReaction.emoji.name ?? "none"} reactionCount=${fullReaction.count ?? 0}`,
        );
      }
      if (fullUser.bot) {
        if (isChecklist) {
          console.debug(
            `[fwa_checklist_reaction_matched] guildId=${tracked.guildId} messageId=${fullReaction.message.id} matched=false reason=bot_user`,
          );
        }
        return;
      }
      if (!tracked || tracked.status !== "ACTIVE") return;

      if (tracked.featureType === TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP) {
        if (fullReaction.emoji.id || fullReaction.emoji.name !== FWA_BASE_SWAP_ACK_EMOJI) return;
        await handleFwaBaseSwapReaction(
          fullReaction.message.id,
          fullUser.id,
          fullReaction.message,
        );
        return;
      }

      if (tracked.featureType === TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) {
        const recorded = await trackedMessageService.recordSyncClaim(
          fullReaction.message.id,
          fullUser.id,
          fullReaction,
        );
        if (recorded && tracked.referenceId) {
          await trackedMessageService.refreshSyncSpinStatusMessage(fullReaction.message);
        }
        return;
      }

      if ((tracked.featureType as string) === TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST) {
        await trackedMessageService.refreshFwaMatchChecklistMessage(fullReaction.message, {
          kind: "add",
          reaction: {
            emoji: {
              id: fullReaction.emoji.id,
              name: fullReaction.emoji.name,
            },
            count: fullReaction.count ?? null,
          },
        });
      }
    } catch (err) {
      console.error(`messageReactionAdd failed: ${formatError(err)}`);
    }
  });
};
