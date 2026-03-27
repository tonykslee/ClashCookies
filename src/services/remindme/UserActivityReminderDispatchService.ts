import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";
import { Client, EmbedBuilder } from "discord.js";
import { formatError } from "../../helper/formatError";
import { formatOffsetMinutes } from "./UserActivityReminderService";

export type UserActivityReminderDispatchInput = {
  discordUserId: string;
  method: UserActivityReminderMethod;
  surfaceChannelId: string | null;
  reminderType: UserActivityReminderType;
  playerTag: string;
  playerName: string | null;
  clanName: string | null;
  eventInstanceKey: string;
  eventEndsAt: Date;
  offsetMinutes: number;
};

export type UserActivityReminderDispatchResult =
  | {
      status: "sent";
      messageId: string;
      deliverySurface: string;
    }
  | {
      status: "failed";
      errorMessage: string;
    };

/** Purpose: deliver one user-activity reminder through DM or ping-here channel routing. */
export class UserActivityReminderDispatchService {
  /** Purpose: send one reminder notification and return delivery metadata for audit persistence. */
  async dispatchReminder(
    client: Client,
    input: UserActivityReminderDispatchInput,
  ): Promise<UserActivityReminderDispatchResult> {
    try {
      const embed = buildUserActivityReminderEmbed(input);
      if (input.method === UserActivityReminderMethod.DM) {
        const user = await client.users.fetch(input.discordUserId).catch(() => null);
        if (!user) {
          return { status: "failed", errorMessage: "dm_user_not_found" };
        }
        const dm = await user.createDM().catch(() => null);
        if (!dm) {
          return { status: "failed", errorMessage: "dm_channel_unavailable" };
        }
        const sent = await dm.send({ embeds: [embed] });
        return {
          status: "sent",
          messageId: sent.id,
          deliverySurface: `DM:${dm.id}`,
        };
      }

      if (!input.surfaceChannelId) {
        return { status: "failed", errorMessage: "ping_here_channel_missing" };
      }
      const channel = await client.channels.fetch(input.surfaceChannelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return {
          status: "failed",
          errorMessage: "ping_here_channel_unavailable_or_not_text_based",
        };
      }
      const sent = await channel.send({
        content: `<@${input.discordUserId}>`,
        allowedMentions: {
          users: [input.discordUserId],
        },
        embeds: [embed],
      });
      return {
        status: "sent",
        messageId: sent.id,
        deliverySurface: `CHANNEL:${input.surfaceChannelId}`,
      };
    } catch (err) {
      return {
        status: "failed",
        errorMessage: formatError(err),
      };
    }
  }
}

/** Purpose: expose one reusable dispatch singleton for scheduler runtime and tests. */
export const userActivityReminderDispatchService =
  new UserActivityReminderDispatchService();

/** Purpose: build deterministic reminder embed content with required player/clan/time-left details. */
function buildUserActivityReminderEmbed(input: UserActivityReminderDispatchInput): EmbedBuilder {
  const playerLabel = input.playerName ? `${input.playerName} (${input.playerTag})` : input.playerTag;
  const clanLabel = input.clanName ?? "Unknown Clan";
  const offsetLabel = formatOffsetMinutes(input.offsetMinutes);
  const typeLabel = input.reminderType;
  const endUnix = Math.floor(input.eventEndsAt.getTime() / 1000);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Activity Reminder - ${typeLabel}`)
    .setDescription(
      [
        `Player: **${playerLabel}**`,
        `Tag: **${input.playerTag}**`,
        `Clan: **${clanLabel}**`,
        `Configured offset: **${offsetLabel}**`,
        `Time left: <t:${endUnix}:R>`,
      ].join("\n"),
    )
    .setFooter({ text: `event:${input.eventInstanceKey}` })
    .setTimestamp(new Date());
}
