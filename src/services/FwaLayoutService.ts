import {
  FwaLayoutType,
  FwaLayouts,
  LayoutRecord,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { prisma } from "../prisma";
import { parseClashLayoutLink } from "./ClashLayoutLinkService";

export const FWA_LAYOUT_TYPES = [
  "RISINGDAWN",
  "BASIC",
  "ICE",
] as const satisfies readonly FwaLayoutType[];

export const FWA_LAYOUT_LINK_PREFIX =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH";

const MIN_SUPPORTED_TOWNHALL = 8;
const MAX_SUPPORTED_TOWNHALL = 18;

export type FwaLayoutSeedRow = {
  Townhall: number;
  Type: FwaLayoutType;
  LayoutLink: string;
  ImageUrl: string | null;
};

export type FwaCanonicalLayout = FwaLayouts & {
  layoutRecord: LayoutRecord | null;
};

export type SetCanonicalFwaLayoutInput = {
  townhall?: number | null;
  type: FwaLayoutType;
  layoutLink: string;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  postedByDiscordUserId?: string | null;
};

export class FwaLayoutTownhallMismatchError extends Error {
  readonly suppliedTownhall: number;
  readonly parsedTownhall: number;

  constructor(suppliedTownhall: number, parsedTownhall: number) {
    super(
      `The supplied Town Hall TH${suppliedTownhall} does not match the layout link's TH${parsedTownhall}.`,
    );
    this.name = "FwaLayoutTownhallMismatchError";
    this.suppliedTownhall = suppliedTownhall;
    this.parsedTownhall = parsedTownhall;
  }
}

export class UnsupportedFwaLayoutTownhallError extends Error {
  readonly townhall: number;

  constructor(townhall: number) {
    super("Unsupported Town Hall. Allowed values: TH8-TH18.");
    this.name = "UnsupportedFwaLayoutTownhallError";
    this.townhall = townhall;
  }
}

type FwaLayoutDb = Pick<PrismaClient, "fwaLayouts" | "layoutRecord">;
type FwaLayoutRootDb = FwaLayoutDb & {
  $transaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
};

export type FwaLayoutServiceOptions = {
  db?: FwaLayoutDb;
  now?: () => Date;
};

/** Purpose: provide one transactional owner for canonical FWA layout designation and compatibility copies. */
export class FwaLayoutService {
  private readonly db: FwaLayoutDb;
  private readonly now: () => Date;

  constructor(options: FwaLayoutServiceOptions = {}) {
    this.db = options.db ?? (prisma as unknown as FwaLayoutDb);
    this.now = options.now ?? (() => new Date());
  }

  /** Purpose: read one canonical FWA designation together with its shared lifecycle record. */
  async findCanonical(input: {
    townhall: number;
    type: FwaLayoutType;
  }): Promise<FwaCanonicalLayout | null> {
    return this.db.fwaLayouts.findUnique({
      where: {
        Townhall_Type: {
          Townhall: input.townhall,
          Type: input.type,
        },
      },
      include: { layoutRecord: true },
    }) as Promise<FwaCanonicalLayout | null>;
  }

  /** Purpose: list canonical FWA designations without exposing legacy raw links to command renderers. */
  async listCanonical(input: {
    type?: FwaLayoutType | null;
  } = {}): Promise<FwaCanonicalLayout[]> {
    return this.db.fwaLayouts.findMany({
      ...(input.type ? { where: { Type: input.type } } : {}),
      orderBy: [{ Type: "asc" }, { Townhall: "asc" }],
      include: { layoutRecord: true },
    }) as Promise<FwaCanonicalLayout[]>;
  }

  /** Purpose: assign one shared LayoutRecord as the canonical FWA layout and synchronize legacy copies atomically. */
  async setCanonicalLayout(
    input: SetCanonicalFwaLayoutInput,
  ): Promise<FwaCanonicalLayout> {
    const parsed = parseClashLayoutLink(input.layoutLink);
    if (
      input.townhall !== undefined &&
      input.townhall !== null &&
      input.townhall !== parsed.townHall
    ) {
      throw new FwaLayoutTownhallMismatchError(input.townhall, parsed.townHall);
    }
    if (!isSupportedTownhall(parsed.townHall)) {
      throw new UnsupportedFwaLayoutTownhallError(parsed.townHall);
    }

    const layoutLink = parsed.layoutLink;
    const presentationData: Prisma.LayoutRecordUpdateInput = {};
    if (input.title !== undefined) presentationData.title = normalizeNullableText(input.title);
    if (input.description !== undefined) {
      presentationData.description = normalizeNullableText(input.description);
    }
    if (input.imageUrl !== undefined) {
      presentationData.imageUrl = normalizeNullableText(input.imageUrl);
    }

    const operation = async (transaction: Prisma.TransactionClient) => {
      const existingFwaLayout = await transaction.fwaLayouts.findUnique({
        where: {
          Townhall_Type: {
            Townhall: parsed.townHall,
            Type: input.type,
          },
        },
      });
      let layoutRecord = await transaction.layoutRecord.findUnique({
        where: { layoutLink },
      });

      if (!layoutRecord) {
        layoutRecord = await transaction.layoutRecord.create({
          data: {
            layoutLink,
            title: input.title === undefined ? null : normalizeNullableText(input.title),
            description:
              input.description === undefined
                ? null
                : normalizeNullableText(input.description),
            imageUrl:
              input.imageUrl === undefined
                ? existingFwaLayout?.ImageUrl ?? null
                : normalizeNullableText(input.imageUrl),
            postedByDiscordUserId: input.postedByDiscordUserId ?? null,
            submittedAt: new Date(this.now().getTime()),
            lastConfirmedAt: null,
            lastConfirmedByDiscordUserId: null,
          },
        });
      } else if (Object.keys(presentationData).length > 0) {
        layoutRecord = await transaction.layoutRecord.update({
          where: { id: layoutRecord.id },
          data: presentationData,
        });
      }

      const fwaLayout = await transaction.fwaLayouts.upsert({
        where: {
          Townhall_Type: {
            Townhall: parsed.townHall,
            Type: input.type,
          },
        },
        create: {
          Townhall: parsed.townHall,
          Type: input.type,
          LayoutLink: layoutRecord.layoutLink,
          ImageUrl: layoutRecord.imageUrl,
          layoutId: layoutRecord.id,
        },
        update: {
          layoutId: layoutRecord.id,
          LayoutLink: layoutRecord.layoutLink,
          ImageUrl: layoutRecord.imageUrl,
        },
        include: { layoutRecord: true },
      });

      return fwaLayout as FwaCanonicalLayout;
    };

    const rootDb = this.db as FwaLayoutRootDb;
    if (typeof rootDb.$transaction === "function") {
      return rootDb.$transaction(operation);
    }
    return operation(this.db as unknown as Prisma.TransactionClient);
  }

  /** Purpose: preserve legacy seed rows while associating missing layout records without manufacturing freshness. */
  async upsertSeedRows(rows: readonly FwaLayoutSeedRow[]): Promise<number> {
    const rootDb = this.db as FwaLayoutRootDb;
    for (const row of rows) {
      const operation = async (transaction: Prisma.TransactionClient) => {
        const existing = await transaction.fwaLayouts.findUnique({
          where: {
            Townhall_Type: { Townhall: row.Townhall, Type: row.Type },
          },
        });

        if (existing?.layoutId) return;

        const currentLink = existing?.LayoutLink ?? row.LayoutLink;
        const currentImage = existing?.ImageUrl ?? row.ImageUrl;
        const layoutRecord = await transaction.layoutRecord.upsert({
          where: { layoutLink: currentLink },
          update: {},
          create: {
            layoutLink: currentLink,
            imageUrl: currentImage,
            submittedAt: null,
            lastConfirmedAt: null,
            lastConfirmedByDiscordUserId: null,
          },
        });

        const saved = await transaction.fwaLayouts.upsert({
          where: {
            Townhall_Type: { Townhall: row.Townhall, Type: row.Type },
          },
          create: {
            Townhall: row.Townhall,
            Type: row.Type,
            LayoutLink: row.LayoutLink,
            ImageUrl: row.ImageUrl,
            layoutId: layoutRecord.id,
          },
          update: { layoutId: layoutRecord.id },
        });

        if (saved.layoutId !== layoutRecord.id) {
          await transaction.fwaLayouts.update({
            where: {
              Townhall_Type: { Townhall: row.Townhall, Type: row.Type },
            },
            data: { layoutId: layoutRecord.id },
          });
        }
      };

      if (typeof rootDb.$transaction === "function") {
        await rootDb.$transaction(operation);
      } else {
        await operation(this.db as unknown as Prisma.TransactionClient);
      }
    }
    return rows.length;
  }
}

/** Purpose: normalize optional presentation text while keeping empty input out of persisted copies. */
function normalizeNullableText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

/** Purpose: normalize optional layout type input to a supported enum value. */
export function normalizeLayoutType(input?: string | null): FwaLayoutType {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "BASIC") return "BASIC";
  if (normalized === "ICE") return "ICE";
  return "RISINGDAWN";
}

/** Purpose: enforce supported Town Hall values for FWA layout lookup/edit flows. */
export function isSupportedTownhall(th: number): boolean {
  return Number.isInteger(th) && th >= MIN_SUPPORTED_TOWNHALL && th <= MAX_SUPPORTED_TOWNHALL;
}

/** Purpose: validate that a layout URL uses the shared Clash parser's accepted domain. */
export function isValidFwaLayoutLink(input: string): boolean {
  try {
    parseClashLayoutLink(input);
    return true;
  } catch {
    return false;
  }
}

/** Purpose: validate optional image URL input for layout preview links. */
export function isValidImageUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Purpose: wrap links in angle brackets to suppress Discord embed expansion. */
export function wrapDiscordLink(url: string): string {
  return `<${url.trim()}>`;
}

const defaultFwaLayoutService = new FwaLayoutService();

/** Purpose: fetch all stored layout rows for legacy /layout compatibility. */
export async function getAllFwaLayouts(): Promise<FwaLayouts[]> {
  return prisma.fwaLayouts.findMany({
    orderBy: { Townhall: "asc" },
  });
}

/** Purpose: fetch one stored layout by composite key for legacy /layout compatibility. */
export async function getFwaLayout(
  townhall: number,
  type: FwaLayoutType,
): Promise<FwaLayouts | null> {
  return prisma.fwaLayouts.findUnique({
    where: {
      Townhall_Type: {
        Townhall: townhall,
        Type: type,
      },
    },
  });
}

/** Purpose: route legacy /layout edits through the canonical shared LayoutRecord association. */
export async function upsertFwaLayout(params: {
  townhall: number;
  type: FwaLayoutType;
  layoutLink: string;
  imageUrl?: string;
  postedByDiscordUserId?: string | null;
}): Promise<FwaLayouts> {
  const result = await defaultFwaLayoutService.setCanonicalLayout({
    townhall: params.townhall,
    type: params.type,
    layoutLink: params.layoutLink,
    ...(params.imageUrl !== undefined ? { imageUrl: params.imageUrl } : {}),
    postedByDiscordUserId: params.postedByDiscordUserId,
  });
  return result;
}

/** Purpose: keep backward-compatible layout-link-only writes on the canonical association path. */
export async function upsertFwaLayoutLink(params: {
  townhall: number;
  type: FwaLayoutType;
  layoutLink: string;
  postedByDiscordUserId?: string | null;
}): Promise<FwaLayouts> {
  return upsertFwaLayout(params);
}

/** Purpose: seed only missing rows and repair missing associations from the row's current compatibility values. */
export async function upsertFwaLayoutSeedRows(
  rows: readonly FwaLayoutSeedRow[],
): Promise<number> {
  return defaultFwaLayoutService.upsertSeedRows(rows);
}

export const fwaLayoutService = defaultFwaLayoutService;
