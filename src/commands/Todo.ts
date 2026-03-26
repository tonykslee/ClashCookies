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
import { CoCService } from "../services/CoCService";
import {
  buildTodoPagesForUser,
  normalizeTodoType,
  TODO_TYPES,
  type TodoType,
} from "../services/TodoService";

const TODO_PAGE_BUTTON_PREFIX = "todo-page";
const TODO_EMBED_COLOR = 0x5865f2;

type TodoRenderResult =
  | {
      ok: true;
      payload: {
        embeds: EmbedBuilder[];
        components: ActionRowBuilder<ButtonBuilder>[];
      };
    }
  | { ok: false; message: string };

/** Purpose: build one stable todo-page button custom-id. */
export function buildTodoPageButtonCustomId(
  userId: string,
  type: TodoType,
): string {
  return `${TODO_PAGE_BUTTON_PREFIX}:${userId}:${type}`;
}

/** Purpose: guard whether a button custom-id belongs to `/todo` paging. */
export function isTodoPageButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${TODO_PAGE_BUTTON_PREFIX}:`);
}

/** Purpose: parse todo-page button custom-id with user scope and page type. */
function parseTodoPageButtonCustomId(
  customId: string,
): { userId: string; type: TodoType } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== TODO_PAGE_BUTTON_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  if (!userId) return null;
  return { userId, type: normalizeTodoType(parts[2]) };
}

/** Purpose: build todo page-switch buttons with active page highlight. */
function buildTodoPageButtons(
  commandUserId: string,
  activeType: TodoType,
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = TODO_TYPES.map((type) =>
    new ButtonBuilder()
      .setCustomId(buildTodoPageButtonCustomId(commandUserId, type))
      .setLabel(type)
      .setStyle(type === activeType ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
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
  interaction: ChatInputCommandInteraction | ButtonInteraction;
  cocService: CoCService;
  selectedType: TodoType;
  commandUserId: string;
}): Promise<TodoRenderResult> {
  const pages = await buildTodoPagesForUser({
    discordUserId: input.commandUserId,
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
      components: buildTodoPageButtons(input.commandUserId, normalizedType),
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

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const result = await buildTodoRenderResult({
    interaction,
    cocService,
    selectedType: parsed.type,
    commandUserId: parsed.userId,
  });
  if (!result.ok) {
    await interaction.update({
      content: result.message,
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update({
    content: null,
    ...result.payload,
  });
}

export const Todo: Command = {
  name: "todo",
  description: "Show todo status across your linked player tags",
  options: [
    {
      name: "type",
      description: "Todo category page to open first",
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: TODO_TYPES.map((type) => ({ name: type, value: type })),
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService,
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const selectedType = normalizeTodoType(
      interaction.options.getString("type", true),
    );
    const result = await buildTodoRenderResult({
      interaction,
      cocService,
      selectedType,
      commandUserId: interaction.user.id,
    });
    if (!result.ok) {
      await interaction.editReply(result.message);
      return;
    }

    await interaction.editReply(result.payload);
  },
};
