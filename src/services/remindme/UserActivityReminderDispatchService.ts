import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";
import { Client } from "discord.js";
import { formatError } from "../../helper/formatError";
import { splitDiscordLineMessages } from "../../helper/discordLineMessageSplit";
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
      const contents = buildUserActivityReminderContents(input);
      if (input.method === UserActivityReminderMethod.DM) {
        const user = await client.users.fetch(input.discordUserId).catch(() => null);
        if (!user) {
          return { status: "failed", errorMessage: "dm_user_not_found" };
        }
        const dm = await user.createDM().catch(() => null);
        if (!dm) {
          return { status: "failed", errorMessage: "dm_channel_unavailable" };
        }
        let firstMessageId: string | null = null;
        for (const content of contents) {
          const sent = await dm.send({ content });
          if (!firstMessageId) {
            firstMessageId = sent.id;
          }
        }
        return {
          status: "sent",
          messageId: firstMessageId ?? "unknown",
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
      let firstMessageId: string | null = null;
      for (const content of contents) {
        const sent = await channel.send({
          content,
          allowedMentions: {
            users: [input.discordUserId],
          },
        });
        if (!firstMessageId) {
          firstMessageId = sent.id;
        }
      }
      return {
        status: "sent",
        messageId: firstMessageId ?? "unknown",
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

/** Purpose: build deterministic reminder message content with required player/clan/time-left details. */
function buildUserActivityReminderContents(
  input: UserActivityReminderDispatchInput,
): string[] {
  const playerLabel = input.playerName ? `${input.playerName} (${input.playerTag})` : input.playerTag;
  const clanLabel = input.clanName ?? "Unknown Clan";
  const offsetLabel = formatOffsetMinutes(input.offsetMinutes);
  const typeLabel = input.reminderType;
  const endUnix = Math.floor(input.eventEndsAt.getTime() / 1000);
  const headingPrefix =
    input.method === UserActivityReminderMethod.PING_HERE
      ? `### <@${input.discordUserId}> Activity Reminder - ${typeLabel}`
      : `### Activity Reminder - ${typeLabel}`;

  return splitDiscordLineMessages({
    lines: [
      headingPrefix,
      `Player: ${playerLabel}`,
      `Tag: ${input.playerTag}`,
      `Clan: ${clanLabel}`,
      `Configured offset: ${offsetLabel}`,
      `Time left: <t:${endUnix}:R>`,
      `Ends at: <t:${endUnix}:F> (<t:${endUnix}:R>)`,
      `Event: ${input.eventInstanceKey}`,
    ],
    maxMessages: 3,
  });
}

export const buildUserActivityReminderContentsForTest =
  buildUserActivityReminderContents;
