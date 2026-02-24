import { ChatInputCommandInteraction, DiscordAPIError } from "discord.js";
import { formatError } from "./formatError";
import { truncateDiscordContent } from "./discordContent";

export async function safeReply(
  interaction: ChatInputCommandInteraction,
  options: { content: string; ephemeral?: boolean }
): Promise<void> {
  const safeOptions = { ...options, content: truncateDiscordContent(options.content) };
  try {
    if (interaction.deferred) {
      await interaction.editReply(safeOptions);
    } else if (!interaction.replied) {
      await interaction.reply(safeOptions);
    }
  } catch (err: any) {
    if (
      err?.code === 40060 || // already acknowledged
      err?.code === 10062    // unknown interaction
    ) {
      return; // expected in duplicate handler scenarios
    }

    console.error(`safeReply unexpected error: ${formatError(err)}`);
  }
}
