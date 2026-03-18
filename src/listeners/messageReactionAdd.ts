import { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { formatError } from "../helper/formatError";
import { FWA_BASE_SWAP_ACK_EMOJI, handleFwaBaseSwapReaction } from "../commands/Fwa";

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
      if (!fullReaction || !fullUser || fullUser.bot) return;
      if (fullReaction.emoji.id || fullReaction.emoji.name !== FWA_BASE_SWAP_ACK_EMOJI) return;
      await handleFwaBaseSwapReaction(
        fullReaction.message.id,
        fullUser.id,
        fullReaction.message,
      );
    } catch (err) {
      console.error(`messageReactionAdd failed: ${formatError(err)}`);
    }
  });
};
