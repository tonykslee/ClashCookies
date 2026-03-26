import { ReminderType } from "@prisma/client";
import { Client, EmbedBuilder } from "discord.js";
import { formatError } from "../../helper/formatError";

export type ReminderDispatchInput = {
  guildId: string;
  channelId: string;
  reminderId: string;
  type: ReminderType;
  clanTag: string;
  clanName: string | null;
  offsetSeconds: number;
  eventIdentity: string;
  eventEndsAt: Date;
  eventLabel: string;
};

export type ReminderDispatchResult =
  | {
      status: "sent";
      messageId: string;
    }
  | {
      status: "failed";
      errorMessage: string;
    };

/** Purpose: send one reminder embed message to configured channels with deterministic type-aware content. */
export class ReminderDispatchService {
  /** Purpose: dispatch one reminder notification and return sent/failed metadata for fire-log persistence. */
  async dispatchReminder(client: Client, input: ReminderDispatchInput): Promise<ReminderDispatchResult> {
    try {
      const channel = await client.channels.fetch(input.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return {
          status: "failed",
          errorMessage: "channel_unavailable_or_not_text_based",
        };
      }

      const embed = buildReminderDispatchEmbed(input);
      const sent = await channel.send({
        embeds: [embed],
      });
      return {
        status: "sent",
        messageId: sent.id,
      };
    } catch (error) {
      return {
        status: "failed",
        errorMessage: formatError(error),
      };
    }
  }
}

/** Purpose: expose one shared reminder dispatch service singleton. */
export const reminderDispatchService = new ReminderDispatchService();

/** Purpose: build concise reminder embed content keyed by reminder type and event timing context. */
function buildReminderDispatchEmbed(input: ReminderDispatchInput): EmbedBuilder {
  const clanLabel = input.clanName
    ? `${input.clanName} (${input.clanTag})`
    : input.clanTag;
  const offsetLabel = formatOffsetLabel(input.offsetSeconds);
  const remainingSeconds = Math.max(0, Math.floor((input.eventEndsAt.getTime() - Date.now()) / 1000));
  const remainingLabel = `<t:${Math.floor(input.eventEndsAt.getTime() / 1000)}:R>`;
  const titlePrefix = getReminderTitlePrefix(input.type);
  const color = getReminderTypeColor(input.type);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${titlePrefix} Reminder`)
    .setDescription([
      `Clan: **${clanLabel}**`,
      `Configured offset: **${offsetLabel}**`,
      `Event timing: **${input.eventLabel}**`,
      `Time remaining: ${remainingLabel} (${remainingSeconds}s)`,
    ].join("\n"))
    .setFooter({
      text: `reminder:${input.reminderId} | identity:${input.eventIdentity}`,
    })
    .setTimestamp(new Date());
}

/** Purpose: map reminder types to stable friendly heading prefixes. */
function getReminderTitlePrefix(type: ReminderType): string {
  if (type === ReminderType.WAR_CWL) return "WAR/CWL";
  if (type === ReminderType.RAIDS) return "Raid Weekend";
  if (type === ReminderType.GAMES) return "Clan Games";
  return "Event";
}

/** Purpose: map reminder types to deterministic embed accent colors. */
function getReminderTypeColor(type: ReminderType): number {
  if (type === ReminderType.WAR_CWL) return 0xed4245;
  if (type === ReminderType.RAIDS) return 0x5865f2;
  if (type === ReminderType.GAMES) return 0x57f287;
  return 0xfee75c;
}

/** Purpose: render one offset in human-readable compact `HhMm` format for embeds. */
function formatOffsetLabel(offsetSeconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(offsetSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}
