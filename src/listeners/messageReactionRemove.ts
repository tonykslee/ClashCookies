import { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { formatError } from "../helper/formatError";
import { trackedMessageService, TRACKED_MESSAGE_FEATURE_TYPE } from "../services/TrackedMessageService";

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
    console.warn("messageReactionRemove already registered, skipping");
    return;
  }

  isRegistered = true;

  client.on("messageReactionRemove", async (reaction, user) => {
    try {
      const fullReaction = await materializeReaction(reaction);
      const fullUser = await materializeUser(user);
      if (!fullReaction || !fullUser || fullUser.bot) return;
      const tracked = await trackedMessageService.getActiveByMessageId(fullReaction.message.id);
      if (!tracked || tracked.status !== "ACTIVE") return;
      if (tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) return;
      await trackedMessageService.removeSyncClaim(fullReaction.message.id, fullUser.id, fullReaction);
    } catch (err) {
      console.error(`messageReactionRemove failed: ${formatError(err)}`);
    }
  });
};
