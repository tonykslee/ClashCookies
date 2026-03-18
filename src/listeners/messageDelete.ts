import { Client, Message, PartialMessage } from "discord.js";
import { formatError } from "../helper/formatError";
import { expireFwaBaseSwapAnnouncementState } from "../commands/Fwa";

let isRegistered = false;

async function materializeMessage(message: Message | PartialMessage): Promise<Message | PartialMessage | null> {
  if (message.partial) {
    try {
      return await message.fetch();
    } catch {
      return message;
    }
  }
  return message;
}

export default (client: Client): void => {
  if (isRegistered) {
    console.warn("messageDelete already registered, skipping");
    return;
  }

  isRegistered = true;

  client.on("messageDelete", async (message) => {
    try {
      const fullMessage = await materializeMessage(message);
      if (!fullMessage?.id) return;
      await expireFwaBaseSwapAnnouncementState(fullMessage.id);
    } catch (err) {
      console.error(`messageDelete failed: ${formatError(err)}`);
    }
  });
};
