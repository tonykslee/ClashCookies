import { LayoutRecord, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { parseClashLayoutLink } from "./ClashLayoutLinkService";

export type CreateLayoutRecordInput = {
  layoutLink: string;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  postedByDiscordUserId?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  discordMessageId?: string | null;
};

export type LayoutServiceOptions = {
  db?: Pick<PrismaClient, "layoutRecord">;
  now?: () => Date;
};

/** Purpose: report that a normalized layout link already owns a lifecycle record. */
export class DuplicateLayoutLinkError extends Error {
  readonly layoutLink: string;

  constructor(layoutLink: string) {
    super(`A layout record already exists for this exact layout link: ${layoutLink}`);
    this.name = "DuplicateLayoutLinkError";
    this.layoutLink = layoutLink;
  }
}

/** Purpose: expose the semantic freshness timestamp without coupling callers to database update metadata. */
export function deriveLayoutFreshnessTimestamp(
  layout: Pick<LayoutRecord, "lastConfirmedAt" | "submittedAt">
): Date | null {
  return layout.lastConfirmedAt ?? layout.submittedAt;
}

/** Purpose: provide DB-first lifecycle operations for shared persisted Clash layout records. */
export class LayoutService {
  private readonly db: Pick<PrismaClient, "layoutRecord">;
  private readonly now: () => Date;

  constructor(options: LayoutServiceOptions = {}) {
    this.db = options.db ?? prisma;
    this.now = options.now ?? (() => new Date());
  }

  /** Purpose: create a new layout lifecycle with an explicit submission timestamp. */
  async create(input: CreateLayoutRecordInput): Promise<LayoutRecord> {
    const { layoutLink } = parseClashLayoutLink(input.layoutLink);
    const existing = await this.findByLayoutLink(layoutLink);
    if (existing) {
      throw new DuplicateLayoutLinkError(layoutLink);
    }

    try {
      return await this.db.layoutRecord.create({
        data: {
          layoutLink,
          title: input.title ?? null,
          description: input.description ?? null,
          imageUrl: input.imageUrl ?? null,
          postedByDiscordUserId: input.postedByDiscordUserId ?? null,
          discordGuildId: input.discordGuildId ?? null,
          discordChannelId: input.discordChannelId ?? null,
          discordMessageId: input.discordMessageId ?? null,
          submittedAt: new Date(this.now().getTime()),
          lastConfirmedAt: null,
          lastConfirmedByDiscordUserId: null,
        },
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        try {
          const racedRecord = await this.findByLayoutLink(layoutLink);
          if (racedRecord) {
            throw new DuplicateLayoutLinkError(layoutLink);
          }
        } catch (rereadError) {
          if (rereadError instanceof DuplicateLayoutLinkError) {
            throw rereadError;
          }
        }
      }
      throw error;
    }
  }

  /** Purpose: find one layout lifecycle by its stable identifier. */
  async findById(id: string): Promise<LayoutRecord | null> {
    return this.db.layoutRecord.findUnique({ where: { id } });
  }

  /** Purpose: find one layout lifecycle by the exact normalized link. */
  async findByLayoutLink(layoutLink: string): Promise<LayoutRecord | null> {
    return this.db.layoutRecord.findUnique({ where: { layoutLink: layoutLink.trim() } });
  }

  /** Purpose: record a successful layout opening without changing submission or presentation provenance. */
  async confirmSuccessfulOpening(input: {
    id: string;
    discordUserId: string;
  }): Promise<LayoutRecord> {
    return this.db.layoutRecord.update({
      where: { id: input.id },
      data: {
        lastConfirmedAt: new Date(this.now().getTime()),
        lastConfirmedByDiscordUserId: input.discordUserId,
      },
    });
  }

  /** Purpose: derive the current semantic freshness timestamp for one persisted layout. */
  deriveFreshnessTimestamp(
    layout: Pick<LayoutRecord, "lastConfirmedAt" | "submittedAt">
  ): Date | null {
    return deriveLayoutFreshnessTimestamp(layout);
  }
}

/** Purpose: identify Prisma unique conflicts without assuming which unique constraint lost the race. */
function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export const layoutService = new LayoutService();
