import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { listPlayerLinksForDiscordUser } from "../services/PlayerLinkService";
import { CoCService } from "../services/CoCService";
import {
  buildTodoPagesForUser,
  invalidateTodoRenderCacheForUser,
  normalizeTodoType,
  TODO_TYPES,
  type TodoType,
} from "../services/TodoService";
import { todoSnapshotService } from "../services/TodoSnapshotService";
import { todoLastViewedTypeService } from "../services/TodoLastViewedTypeService";

const TODO_PAGE_BUTTON_PREFIX = "todo-page";
const TODO_REFRESH_BUTTON_PREFIX = "todo-refresh";
const TODO_EMBED_COLOR = 0x5865f2;
const TODO_GUILD_SCOPE_DM = "dm";
const TODO_REFRESH_ERROR_MESSAGE =
  "Failed to refresh todo data. Please try again.";
const TODO_REFRESH_BUTTON_EMOJI = "🔄";
const todoRefreshInFlightByMessageId = new Set<string>();

type TodoButtonScope = {
  guildScopeId: string;
  requesterUserId: string;
  targetUserId: string;
};

type ParsedTodoButtonScope = {
  guildScopeId: string | null;
  requesterUserId: string;
  targetUserId: string;
  type: TodoType;
};

type TodoRenderResult =
  | {
      ok: true;
      payload: {
        embeds: EmbedBuilder[];
        components: ActionRowBuilder<ButtonBuilder>[];
      };
    }
  | { ok: false; message: string };

/** Purpose: persist one remembered `/todo` page type without blocking command UX on storage errors. */
async function rememberLastViewedTodoType(input: {
  discordUserId: string;
  type: TodoType;
}): Promise<void> {
  try {
    await todoLastViewedTypeService.setLastViewedType({
      discordUserId: input.discordUserId,
      type: normalizeTodoType(input.type),
    });
  } catch (err) {
    console.error(
      `[todo-last-viewed] set_failed user=${input.discordUserId} type=${input.type} error=${formatError(err)}`,
    );
  }
}

/** Purpose: resolve one remembered `/todo` page type with safe null fallback on read errors. */
async function resolveRememberedTodoType(
  discordUserId: string,
): Promise<TodoType | null> {
  try {
    return await todoLastViewedTypeService.getLastViewedType({ discordUserId });
  } catch (err) {
    console.error(
      `[todo-last-viewed] get_failed user=${discordUserId} error=${formatError(err)}`,
    );
    return null;
  }
}

/** Purpose: rebuild one user's todo snapshots and invalidate stale render cache before rerender. */
async function refreshTodoSnapshotsForDiscordUser(input: {
  discordUserId: string;
  cocService: CoCService;
}): Promise<void> {
  const links = await listPlayerLinksForDiscordUser({
    discordUserId: input.discordUserId,
  });
  const linkedTags = [...new Set(links.map((row) => row.playerTag))];
  if (linkedTags.length > 0) {
    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: linkedTags,
      cocService: input.cocService,
    });
  }
  invalidateTodoRenderCacheForUser(input.discordUserId);
}

/** Purpose: build one stable guild scope token from guild-id or DM context. */
function resolveTodoGuildScopeId(guildId: string | null | undefined): string {
  const normalized = String(guildId ?? TODO_GUILD_SCOPE_DM).trim();
  return normalized.length > 0 ? normalized : TODO_GUILD_SCOPE_DM;
}

/** Purpose: validate that one parsed guild scope still matches the interaction guild. */
function isTodoGuildScopeMismatch(
  parsedGuildScopeId: string | null,
  interactionGuildId: string | null,
): boolean {
  if (!parsedGuildScopeId) return false;
  return parsedGuildScopeId !== resolveTodoGuildScopeId(interactionGuildId);
}

/** Purpose: build one stable todo-page button custom-id. */
export function buildTodoPageButtonCustomId(
  userId: string,
  type: TodoType,
): string;
export function buildTodoPageButtonCustomId(
  input: TodoButtonScope & { type: TodoType },
): string;
export function buildTodoPageButtonCustomId(
  inputOrUserId: (TodoButtonScope & { type: TodoType }) | string,
  maybeType?: TodoType,
): string {
  if (typeof inputOrUserId === "string") {
    const userId = inputOrUserId;
    const type = normalizeTodoType(maybeType);
    return `${TODO_PAGE_BUTTON_PREFIX}:${userId}:${type}`;
  }
  const guildScopeId = resolveTodoGuildScopeId(inputOrUserId.guildScopeId);
  return `${TODO_PAGE_BUTTON_PREFIX}:${guildScopeId}:${inputOrUserId.requesterUserId}:${inputOrUserId.targetUserId}:${normalizeTodoType(inputOrUserId.type)}`;
}

/** Purpose: build one stable todo-refresh button custom-id for targeted snapshot rebuild. */
export function buildTodoRefreshButtonCustomId(
  input: TodoButtonScope & { type: TodoType },
): string {
  const guildScopeId = resolveTodoGuildScopeId(input.guildScopeId);
  return `${TODO_REFRESH_BUTTON_PREFIX}:${guildScopeId}:${input.requesterUserId}:${input.targetUserId}:${normalizeTodoType(input.type)}`;
}

/** Purpose: guard whether a button custom-id belongs to `/todo` paging. */
export function isTodoPageButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${TODO_PAGE_BUTTON_PREFIX}:`);
}

/** Purpose: guard whether a button custom-id belongs to `/todo` refresh. */
export function isTodoRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${TODO_REFRESH_BUTTON_PREFIX}:`);
}

/** Purpose: parse todo-page button custom-id with requester/target scope and page type. */
function parseTodoPageButtonCustomId(
  customId: string,
): ParsedTodoButtonScope | null {
  const parts = String(customId ?? "").split(":");
  if (parts[0] !== TODO_PAGE_BUTTON_PREFIX) return null;

  if (parts.length === 3) {
    const requesterUserId = parts[1]?.trim() ?? "";
    if (!requesterUserId) return null;
    return {
      guildScopeId: null,
      requesterUserId,
      targetUserId: requesterUserId,
      type: normalizeTodoType(parts[2]),
    };
  }

  if (parts.length !== 5) return null;
  const guildScopeId = resolveTodoGuildScopeId(parts[1]);
  const requesterUserId = parts[2]?.trim() ?? "";
  const targetUserId = parts[3]?.trim() ?? "";
  if (!requesterUserId || !targetUserId) return null;
  return {
    guildScopeId,
    requesterUserId,
    targetUserId,
    type: normalizeTodoType(parts[4]),
  };
}

/** Purpose: parse todo-refresh button custom-id with requester/target scope and selected page type. */
function parseTodoRefreshButtonCustomId(
  customId: string,
): ParsedTodoButtonScope | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 5 || parts[0] !== TODO_REFRESH_BUTTON_PREFIX) return null;
  const guildScopeId = resolveTodoGuildScopeId(parts[1]);
  const requesterUserId = parts[2]?.trim() ?? "";
  const targetUserId = parts[3]?.trim() ?? "";
  if (!requesterUserId || !targetUserId) return null;
  return {
    guildScopeId,
    requesterUserId,
    targetUserId,
    type: normalizeTodoType(parts[4]),
  };
}

/** Purpose: build todo page-switch buttons with active page highlight. */
function buildTodoComponentRows(
  scope: TodoButtonScope,
  activeType: TodoType,
): ActionRowBuilder<ButtonBuilder>[] {
  const pagingButtons = TODO_TYPES.map((type) =>
    new ButtonBuilder()
      .setCustomId(
        buildTodoPageButtonCustomId({
          guildScopeId: scope.guildScopeId,
          requesterUserId: scope.requesterUserId,
          targetUserId: scope.targetUserId,
          type,
        }),
      )
      .setLabel(type)
      .setStyle(type === activeType ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  const refreshButton = new ButtonBuilder()
    .setCustomId(
      buildTodoRefreshButtonCustomId({
        guildScopeId: scope.guildScopeId,
        requesterUserId: scope.requesterUserId,
        targetUserId: scope.targetUserId,
        type: activeType,
      }),
    )
    .setEmoji(TODO_REFRESH_BUTTON_EMOJI)
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(pagingButtons),
    new ActionRowBuilder<ButtonBuilder>().addComponents(refreshButton),
  ];
}

/** Purpose: build one todo embed for the selected page type. */
function buildTodoEmbed(input: {
  selectedType: TodoType;
  linkedPlayerCount: number;
  pageText: string;
}): EmbedBuilder {
  const pageIndex = TODO_TYPES.indexOf(input.selectedType);
  const safeIndex = pageIndex >= 0 ? pageIndex : 0;
  return new EmbedBuilder()
    .setColor(TODO_EMBED_COLOR)
    .setTitle(`Todo - ${input.selectedType}`)
    .setDescription(input.pageText || "No todo rows available.")
    .setFooter({
      text: `Page ${safeIndex + 1}/${TODO_TYPES.length} - Linked players: ${input.linkedPlayerCount}`,
    });
}

/** Purpose: build a rendered todo response payload for one selected page type. */
async function buildTodoRenderResult(input: {
  cocService: CoCService;
  selectedType: TodoType;
  scope: TodoButtonScope;
}): Promise<TodoRenderResult> {
  const pages = await buildTodoPagesForUser({
    discordUserId: input.scope.targetUserId,
    cocService: input.cocService,
  });
  if (pages.linkedPlayerCount <= 0) {
    return {
      ok: false,
      message:
        "no_linked_tags: no linked player tags found for your Discord account. Use `/link create player-tag:<tag>` first.",
    };
  }

  const normalizedType = normalizeTodoType(input.selectedType);
  return {
    ok: true,
    payload: {
      embeds: [
        buildTodoEmbed({
          selectedType: normalizedType,
          linkedPlayerCount: pages.linkedPlayerCount,
          pageText: pages.pages[normalizedType],
        }),
      ],
      components: buildTodoComponentRows(input.scope, normalizedType),
    },
  };
}

/** Purpose: handle `/todo` page button interactions with strict user scoping. */
export async function handleTodoPageButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseTodoPageButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (isTodoGuildScopeMismatch(parsed.guildScopeId, interaction.guildId)) {
    await interaction.reply({
      ephemeral: true,
      content: "This todo view is no longer valid for this guild.",
    });
    return;
  }

  if (interaction.user.id !== parsed.requesterUserId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const result = await buildTodoRenderResult({
    cocService,
    selectedType: parsed.type,
    scope: {
      guildScopeId: parsed.guildScopeId || resolveTodoGuildScopeId(interaction.guildId),
      requesterUserId: parsed.requesterUserId,
      targetUserId: parsed.targetUserId,
    },
  });
  if (!result.ok) {
    await interaction.update({
      content: result.message,
      embeds: [],
      components: [],
    });
    return;
  }

  await rememberLastViewedTodoType({
    discordUserId: parsed.requesterUserId,
    type: parsed.type,
  });

  await interaction.update({
    content: null,
    ...result.payload,
  });
}

/** Purpose: handle `/todo` refresh button interactions with targeted scoped snapshot rebuild. */
export async function handleTodoRefreshButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseTodoRefreshButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (isTodoGuildScopeMismatch(parsed.guildScopeId, interaction.guildId)) {
    await interaction.reply({
      ephemeral: true,
      content: "This todo view is no longer valid for this guild.",
    });
    return;
  }

  if (interaction.user.id !== parsed.requesterUserId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const messageId = String(interaction.message?.id ?? "");
  if (messageId && todoRefreshInFlightByMessageId.has(messageId)) {
    await interaction.reply({
      ephemeral: true,
      content: "A refresh is already in progress for this todo view.",
    });
    return;
  }

  if (messageId) {
    todoRefreshInFlightByMessageId.add(messageId);
  }

  await interaction.deferUpdate();

  try {
    await refreshTodoSnapshotsForDiscordUser({
      discordUserId: parsed.targetUserId,
      cocService,
    });

    const result = await buildTodoRenderResult({
      cocService,
      selectedType: parsed.type,
      scope: {
        guildScopeId: parsed.guildScopeId || resolveTodoGuildScopeId(interaction.guildId),
        requesterUserId: parsed.requesterUserId,
        targetUserId: parsed.targetUserId,
      },
    });
    if (!result.ok) {
      await interaction.editReply({
        content: result.message,
        embeds: [],
        components: [],
      });
      return;
    }

    await rememberLastViewedTodoType({
      discordUserId: parsed.requesterUserId,
      type: parsed.type,
    });

    await interaction.editReply({
      content: null,
      ...result.payload,
    });
  } catch (err) {
    console.error(
      `[todo-refresh] requester=${parsed.requesterUserId} target=${parsed.targetUserId} guild=${parsed.guildScopeId} type=${parsed.type} error=${formatError(err)}`,
    );
    await interaction
      .followUp({
        ephemeral: true,
        content: TODO_REFRESH_ERROR_MESSAGE,
      })
      .catch(() => undefined);
  } finally {
    if (messageId) {
      todoRefreshInFlightByMessageId.delete(messageId);
    }
  }
}

export const Todo: Command = {
  name: "todo",
  description: "Show todo status across your linked player tags",
  options: [
    {
      name: "type",
      description: "Todo category page to open first",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: TODO_TYPES.map((type) => ({ name: type, value: type })),
    },
    {
      name: "visibility",
      description: "Response visibility",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "private", value: "private" },
        { name: "public", value: "public" },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService,
  ) => {
    const visibility =
      interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    await interaction.deferReply({ ephemeral: !isPublic });

    const explicitTypeInput = interaction.options.getString("type", false);
    const explicitType = explicitTypeInput
      ? normalizeTodoType(explicitTypeInput)
      : null;
    if (explicitType) {
      await rememberLastViewedTodoType({
        discordUserId: interaction.user.id,
        type: explicitType,
      });
    }
    const rememberedType = explicitType
      ? null
      : await resolveRememberedTodoType(interaction.user.id);
    const selectedType = explicitType ?? rememberedType ?? normalizeTodoType(null);

    try {
      await refreshTodoSnapshotsForDiscordUser({
        discordUserId: interaction.user.id,
        cocService,
      });
    } catch (err) {
      console.error(
        `[todo-initial-refresh] user=${interaction.user.id} error=${formatError(err)}`,
      );
      await interaction.editReply(TODO_REFRESH_ERROR_MESSAGE);
      return;
    }

    const result = await buildTodoRenderResult({
      cocService,
      selectedType,
      scope: {
        guildScopeId: resolveTodoGuildScopeId(interaction.guildId),
        requesterUserId: interaction.user.id,
        targetUserId: interaction.user.id,
      },
    });
    if (!result.ok) {
      await interaction.editReply(result.message);
      return;
    }

    await interaction.editReply(result.payload);
  },
};
