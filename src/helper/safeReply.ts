import { ChatInputCommandInteraction } from "discord.js";
import { formatError } from "./formatError";
import { truncateDiscordContent } from "./discordContent";

export async function safeReply(
  interaction: ChatInputCommandInteraction,
  options: { content: string; ephemeral?: boolean }
): Promise<void> {
  const safeOptions = { ...options, content: truncateDiscordContent(options.content) };
  const isCompo = interaction.commandName === "compo";
  const compoSubcommand = (() => {
    if (!isCompo) return "";
    try {
      return interaction.options.getSubcommand(false) ?? "unknown";
    } catch {
      return "unknown";
    }
  })();

  try {
    if (interaction.deferred) {
      if (isCompo) {
        console.log(
          `[compo-command] stage=response_send_attempt command=compo subcommand=${compoSubcommand} method=editReply deferred=1`
        );
      }
      await interaction.editReply(safeOptions);
    } else if (!interaction.replied) {
      if (isCompo) {
        console.log(
          `[compo-command] stage=response_send_attempt command=compo subcommand=${compoSubcommand} method=reply deferred=0`
        );
      }
      await interaction.reply(safeOptions);
    }
  } catch (err: any) {
    if (
      err?.code === 40060 || // already acknowledged
      err?.code === 10062    // unknown interaction
    ) {
      if (isCompo) {
        console.warn(
          `[compo-command-error] stage=response_send_ack_issue subcommand=${compoSubcommand} code=${String(err?.code ?? "")} error=${formatError(err)}`
        );
      }
      return; // expected in duplicate handler scenarios
    }

    if (isCompo) {
      console.error(
        `[compo-command-error] stage=response_send_failed subcommand=${compoSubcommand} code=${String(err?.code ?? "")} error=${formatError(err)}`
      );
    }
    console.error(`safeReply unexpected error: ${formatError(err)}`);
  }
}
