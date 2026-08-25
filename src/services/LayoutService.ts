import { LayoutRecord, Prisma, PrismaClient } from "@prisma/client";
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

type LayoutServiceRootDb = Pick<PrismaClient, "layoutRecord"> &
  Partial<Pick<PrismaClient, "fwaLayouts">> & {
    $transaction?: <T>(
      callback: (transaction: Prisma.TransactionClient) => Promise<T>,
    ) => Promise<T>;
  };

export type LayoutServiceOptions = {
  db?: LayoutServiceRootDb;
  now?: () => Date;
};

export type LayoutRecordDelegate = Pick<
  PrismaClient["layoutRecord"],
  "findUnique" | "create" | "update" | "upsert"
>;

export type LayoutPresentationInput = {
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
};

export type LayoutCreationOptions = {
  submittedAt?: Date | null;
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

/** Purpose: report that a requested layout record does not exist. */
export class LayoutRecordNotFoundError extends Error {
  readonly layoutId: string;

  constructor(layoutId: string) {
    super(`Layout record was not found: ${layoutId}`);
    this.name = "LayoutRecordNotFoundError";
    this.layoutId = layoutId;
  }
}

/** Purpose: prevent a layout record from being silently repointed to another canonical Discord message. */
export class LayoutDiscordPostAlreadyBoundError extends Error {
  readonly layoutId: string;

  constructor(layoutId: string) {
    super(`Layout record is already bound to a different Discord post: ${layoutId}`);
    this.name = "LayoutDiscordPostAlreadyBoundError";
    this.layoutId = layoutId;
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
  private readonly db: LayoutServiceRootDb;
  private readonly now: () => Date;

  constructor(options: LayoutServiceOptions = {}) {
    this.db = options.db ?? prisma;
    this.now = options.now ?? (() => new Date());
  }

  /** Purpose: create a new layout lifecycle and, for root calls, project presentation atomically to FWA compatibility rows. */
  async create(input: CreateLayoutRecordInput): Promise<LayoutRecord> {
    const { layoutLink } = parseClashLayoutLink(input.layoutLink);
    return this.runRootOperation(async (transaction) => {
      const existing = await transaction.layoutRecord.findUnique({ where: { layoutLink } });
      if (existing) {
        throw new DuplicateLayoutLinkError(layoutLink);
      }

      let created: LayoutRecord;
      try {
        created = await this.createRecord(input, layoutLink, transaction.layoutRecord);
      } catch (error) {
        if (isPrismaUniqueConstraintError(error)) {
          const racedRecord = await transaction.layoutRecord.findUnique({ where: { layoutLink } });
          if (racedRecord) {
            throw new DuplicateLayoutLinkError(layoutLink);
          }
        }
        throw error;
      }
      await synchronizeFwaLayoutProjection(transaction.fwaLayouts, created);
      return created;
    });
  }

  /**
   * Purpose: atomically get or create one exact normalized link for canonical FWA association.
   * Root calls own the transaction and compatibility projection; explicitly delegated calls remain record-only because their caller owns the surrounding transaction.
   */
  async getOrCreate(
    input: CreateLayoutRecordInput,
    delegate?: LayoutRecordDelegate,
    options: LayoutCreationOptions = {},
  ): Promise<LayoutRecord> {
    const { layoutLink } = parseClashLayoutLink(input.layoutLink);
    const presentationData = buildPresentationUpdateData(input);
    if (delegate) {
      return this.getOrCreateWithDelegate(input, layoutLink, presentationData, delegate, options);
    }

    return this.runRootOperation((transaction) =>
      this.getOrCreateWithDelegate(
        input,
        layoutLink,
        presentationData,
        transaction.layoutRecord,
        options,
        transaction.fwaLayouts,
      ),
    );
  }

  /** Purpose: keep explicitly delegated FWA transactions record-only because their caller owns projection writes. */
  private async getOrCreateWithDelegate(
    input: CreateLayoutRecordInput,
    layoutLink: string,
    presentationData: Prisma.LayoutRecordUpdateInput,
    delegate: LayoutRecordDelegate,
    options: LayoutCreationOptions,
    fwaLayouts?: Prisma.TransactionClient["fwaLayouts"],
  ): Promise<LayoutRecord> {
    let record: LayoutRecord;
    try {
      record = await delegate.upsert({
        where: { layoutLink },
        update: presentationData,
        create: {
          ...buildCreateData(
            input,
            layoutLink,
            options.submittedAt === undefined
              ? new Date(this.now().getTime())
              : options.submittedAt,
          ),
        },
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const racedRecord = await delegate.findUnique({ where: { layoutLink } });
        if (racedRecord) return racedRecord;
      }
      throw error;
    }
    await synchronizeFwaLayoutProjection(fwaLayouts, record);
    return record;
  }

  /**
   * Purpose: update presentation-only fields without touching lifecycle or Discord provenance state.
   * Root calls atomically maintain transitional FWA compatibility copies; explicitly delegated calls leave that projection to the transaction owner.
   */
  async updatePresentation(
    id: string,
    input: LayoutPresentationInput,
    delegate?: LayoutRecordDelegate,
  ): Promise<LayoutRecord> {
    const data = buildPresentationUpdateData(input);
    if (delegate) {
      return this.updatePresentationWithDelegate(id, data, delegate);
    }
    return this.runRootOperation((transaction) =>
      this.updatePresentationWithDelegate(id, data, transaction.layoutRecord, transaction.fwaLayouts),
    );
  }

  /** Purpose: apply presentation-only data and its compatibility projection through one caller-owned transaction. */
  private async updatePresentationWithDelegate(
    id: string,
    data: Prisma.LayoutRecordUpdateInput,
    delegate: LayoutRecordDelegate,
    fwaLayouts?: Prisma.TransactionClient["fwaLayouts"],
  ): Promise<LayoutRecord> {
    if (Object.keys(data).length === 0) {
      const existing = await delegate.findUnique({ where: { id } });
      if (!existing) throw new LayoutRecordNotFoundError(id);
      return existing;
    }
    const updated = await delegate.update({ where: { id }, data });
    await synchronizeFwaLayoutProjection(fwaLayouts, updated);
    return updated;
  }

  /** Purpose: let root presentation writes atomically maintain transitional FWA compatibility copies. */
  private async runRootOperation<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.db.$transaction) {
      return this.db.$transaction(operation);
    }
    return operation(this.db as unknown as Prisma.TransactionClient);
  }

  /** Purpose: find one layout lifecycle by its stable identifier. */
  async findById(id: string): Promise<LayoutRecord | null> {
    return this.db.layoutRecord.findUnique({ where: { id } });
  }

  /** Purpose: find one layout lifecycle by the exact normalized link. */
  async findByLayoutLink(layoutLink: string): Promise<LayoutRecord | null> {
    return this.db.layoutRecord.findUnique({ where: { layoutLink: layoutLink.trim() } });
  }

  /** Purpose: bind one layout to its canonical Discord post without changing lifecycle timestamps. */
  async attachDiscordPost(input: {
    id: string;
    guildId: string;
    channelId: string;
    messageId: string;
    imageUrl?: string | null;
  }): Promise<LayoutRecord> {
    const layout = await this.findById(input.id);
    if (!layout) {
      throw new LayoutRecordNotFoundError(input.id);
    }

    const target = {
      discordGuildId: input.guildId.trim(),
      discordChannelId: input.channelId.trim(),
      discordMessageId: input.messageId.trim(),
    };
    if (!target.discordGuildId || !target.discordChannelId || !target.discordMessageId) {
      throw new Error("Discord post provenance must include guild, channel, and message IDs.");
    }

    const hasExistingProvenance = Boolean(
      layout.discordGuildId || layout.discordChannelId || layout.discordMessageId
    );
    const isSamePost =
      layout.discordGuildId === target.discordGuildId &&
      layout.discordChannelId === target.discordChannelId &&
      layout.discordMessageId === target.discordMessageId;

    if (hasExistingProvenance && !isSamePost) {
      throw new LayoutDiscordPostAlreadyBoundError(input.id);
    }

    const normalizedImageUrl = input.imageUrl === undefined ? undefined : input.imageUrl?.trim() || null;
    if (
      isSamePost &&
      (normalizedImageUrl === undefined || normalizedImageUrl === layout.imageUrl)
    ) {
      return layout;
    }

    if (isSamePost) {
      return this.db.layoutRecord.update({
        where: { id: input.id },
        data: {
          discordGuildId: target.discordGuildId,
          discordChannelId: target.discordChannelId,
          discordMessageId: target.discordMessageId,
          ...(normalizedImageUrl !== undefined ? { imageUrl: normalizedImageUrl } : {}),
        },
      });
    }

    const firstBinding = await this.db.layoutRecord.updateMany({
      where: {
        id: input.id,
        discordGuildId: null,
        discordChannelId: null,
        discordMessageId: null,
      },
      data: {
        discordGuildId: target.discordGuildId,
        discordChannelId: target.discordChannelId,
        discordMessageId: target.discordMessageId,
        ...(normalizedImageUrl !== undefined ? { imageUrl: normalizedImageUrl } : {}),
      },
    });
    if (firstBinding.count === 1) {
      const boundLayout = await this.findById(input.id);
      if (boundLayout) return boundLayout;
      throw new LayoutRecordNotFoundError(input.id);
    }

    const winningLayout = await this.findById(input.id);
    if (!winningLayout) {
      throw new LayoutRecordNotFoundError(input.id);
    }
    const winningPostMatches =
      winningLayout.discordGuildId === target.discordGuildId &&
      winningLayout.discordChannelId === target.discordChannelId &&
      winningLayout.discordMessageId === target.discordMessageId;
    if (winningPostMatches) return winningLayout;
    throw new LayoutDiscordPostAlreadyBoundError(input.id);
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

  private async createRecord(
    input: CreateLayoutRecordInput,
    layoutLink: string,
    delegate: LayoutRecordDelegate,
  ): Promise<LayoutRecord> {
    return delegate.create({
      data: buildCreateData(input, layoutLink, new Date(this.now().getTime())),
    });
  }
}

/** Purpose: project authoritative LayoutRecord presentation into every transitional FwaLayouts reference. */
async function synchronizeFwaLayoutProjection(
  fwaLayouts: Prisma.TransactionClient["fwaLayouts"] | undefined,
  layout: Pick<LayoutRecord, "id" | "layoutLink" | "imageUrl">,
): Promise<void> {
  if (!fwaLayouts) return;
  await fwaLayouts.updateMany({
    where: { layoutId: layout.id },
    data: {
      LayoutLink: layout.layoutLink,
      ImageUrl: layout.imageUrl,
    },
  });
}

function buildCreateData(
  input: CreateLayoutRecordInput,
  layoutLink: string,
  submittedAt: Date | null,
): Prisma.LayoutRecordCreateInput {
  return {
    layoutLink,
    title: input.title ?? null,
    description: input.description ?? null,
    imageUrl: input.imageUrl ?? null,
    postedByDiscordUserId: input.postedByDiscordUserId ?? null,
    discordGuildId: input.discordGuildId ?? null,
    discordChannelId: input.discordChannelId ?? null,
    discordMessageId: input.discordMessageId ?? null,
    submittedAt,
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
  };
}

function buildPresentationUpdateData(
  input: LayoutPresentationInput,
): Prisma.LayoutRecordUpdateInput {
  const data: Prisma.LayoutRecordUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
  return data;
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
