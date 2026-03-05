import { prisma } from "../prisma";

type SavePostedMessageInput = {
  guildId: string;
  clanTag: string;
  type: string;
  event?: string | null;
  warId?: string | null;
  syncNum?: number | null;
  channelId: string;
  messageId: string;
  messageUrl: string;
  configHash?: string | null;
};

type FindExistingMessageInput = {
  guildId: string;
  clanTag: string;
  warId?: string | null;
  type: string;
  event?: string | null;
};

type FindMailMessageInput = {
  guildId: string;
  clanTag: string;
  warId?: string | null;
};

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

export class PostedMessageService {
  async savePostedMessage(input: SavePostedMessageInput) {
    const clanTag = `#${normalizeTag(input.clanTag)}`;
    const existing =
      input.type === "mail"
        ? await prisma.clanPostedMessage.findFirst({
            where: {
              guildId: input.guildId,
              clanTag,
              type: "mail",
              OR: [{ warId: input.warId ?? null }, { warId: null }],
            },
            orderBy: { createdAt: "desc" },
          })
        : await prisma.clanPostedMessage.findFirst({
            where: {
              guildId: input.guildId,
              clanTag,
              warId: input.warId ?? null,
              type: input.type,
              event: input.event ?? null,
            },
            orderBy: { createdAt: "desc" },
          });
    if (existing) {
      return prisma.clanPostedMessage.update({
        where: { id: existing.id },
        data: {
          warId: input.warId ?? existing.warId,
          channelId: input.channelId,
          messageId: input.messageId,
          messageUrl: input.messageUrl,
          syncNum: input.syncNum ?? null,
          configHash: input.configHash ?? null,
        },
      });
    }
    return prisma.clanPostedMessage.create({
      data: {
        guildId: input.guildId,
        clanTag,
        type: input.type,
        event: input.event ?? null,
        channelId: input.channelId,
        messageId: input.messageId,
        messageUrl: input.messageUrl,
        warId: input.warId ?? null,
        syncNum: input.syncNum ?? null,
        configHash: input.configHash ?? null,
      },
    });
  }

  async findExistingMessage(input: FindExistingMessageInput) {
    return prisma.clanPostedMessage.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: `#${normalizeTag(input.clanTag)}`,
        warId: input.warId ?? null,
        type: input.type,
        event: input.event ?? null,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findMailMessage(input: FindMailMessageInput) {
    return prisma.clanPostedMessage.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: `#${normalizeTag(input.clanTag)}`,
        type: "mail",
        OR: [{ warId: input.warId ?? null }, { warId: null }],
      },
      orderBy: { createdAt: "desc" },
    });
  }
}
