import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Interaction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { Commands } from "../Commands";
import { truncateDiscordContent } from "../helper/discordContent";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { CoCService } from "../services/CoCService";
import { handlePostModalSubmit, isPostModalCustomId } from "../commands/Post";
import {
  handleRecruitmentModalSubmit,
  isRecruitmentModalCustomId,
} from "../commands/Recruitment";
import {
  handleFwaMatchCopyButton,
  handleFwaMatchSelectMenu,
  handleFwaMatchAllianceButton,
  handleFwaMatchTypeEditButton,
  handleFwaOutcomeActionButton,
  handleFwaMatchTypeActionButton,
  handleFwaMatchSyncActionButton,
  handleFwaMatchSkipSyncActionButton,
  handleFwaMatchSkipSyncConfirmButton,
  handleFwaMatchSkipSyncUndoButton,
  handleFwaComplianceViewButton,
  handleFwaMailConfirmButton,
  handleFwaMailConfirmNoPingButton,
  handleFwaMailBackButton,
  handleFwaMailGateResumeButton,
  handleFwaMailRefreshButton,
  handleFwaMatchSendMailButton,
  handleFwaMatchTieBreakerButton,
  handleFwaBaseSwapSplitPostButton,
  isFwaMatchAllianceButtonCustomId,
  isFwaMatchSyncActionButtonCustomId,
  isFwaMatchSkipSyncActionButtonCustomId,
  isFwaMatchSkipSyncConfirmButtonCustomId,
  isFwaMatchSkipSyncUndoButtonCustomId,
  isFwaMailConfirmButtonCustomId,
  isFwaMailConfirmNoPingButtonCustomId,
  isFwaMailBackButtonCustomId,
  isFwaMailGateResumeButtonCustomId,
  isFwaMailRefreshButtonCustomId,
  isFwaMatchSendMailButtonCustomId,
  isFwaMatchTieBreakerButtonCustomId,
  isFwaMatchTypeEditButtonCustomId,
  isFwaOutcomeActionButtonCustomId,
  isFwaMatchSelectCustomId,
  isFwaMatchTypeActionButtonCustomId,
  isFwaComplianceViewButtonCustomId,
  isFwaBaseSwapSplitPostButtonCustomId,
  handlePointsPostButton,
  isFwaMatchCopyButtonCustomId,
  isPointsPostButtonCustomId,
} from "../commands/Fwa";
import {
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../services/CommandPermissionService";
import { runWithCoCQueueContext } from "../services/CoCQueueContext";
import { runWithTelemetryContext } from "../services/telemetry/context";
import { TelemetryIngestService, toFailureTelemetry } from "../services/telemetry/ingest";
import {
  handleNotifyWarPreviewPostButton,
  isNotifyWarPreviewPostButtonCustomId,
} from "../commands/Notify";
import {
  handleCompoHeatMapRefCopyButton,
  handleCompoRefreshButton,
  handleCompoAdviceClanSelectMenuInteraction,
  isCompoHeatMapRefCopyButtonCustomId,
  isCompoRefreshButtonCustomId,
  isCompoAdviceClanSelectMenuCustomId,
} from "../commands/Compo";
import {
  handleNotifyWarEndedViewButton,
  handleNotifyWarRefreshButton,
  isNotifyWarEndedViewButtonCustomId,
  isNotifyWarRefreshButtonCustomId,
} from "../services/WarEventLogService";
import {
  handleLinkEmbedButtonInteraction,
  handleLinkEmbedModalSubmit,
  handleReminderLinkButtonInteraction,
  handleReminderLinkCancelButtonInteraction,
  handleReminderLinkConfirmButtonInteraction,
  handleLinkListSelectMenu,
  handleLinkListSortButton,
  isLinkEmbedAccountButtonCustomId,
  isReminderLinkButtonCustomId,
  isReminderLinkCancelButtonCustomId,
  isReminderLinkConfirmButtonCustomId,
  isLinkEmbedModalCustomId,
  isLinkListSelectCustomId,
  isLinkListSortButtonCustomId,
} from "../commands/Link";
import {
  handleCwlRotationImportButtonInteraction,
  isCwlRotationImportButtonCustomId,
  handleCwlRotationImportSelectMenuInteraction,
  isCwlRotationImportSelectMenuCustomId,
  handleCwlRotationShowButtonInteraction,
  isCwlRotationShowButtonCustomId,
  handleCwlRotationShowSelectMenuInteraction,
  isCwlRotationShowSelectMenuCustomId,
} from "../commands/Cwl";
import {
  handleRosterPostSettingsActionButtonInteraction,
  handleRosterReportPingButtonInteraction,
  handleRosterPingActionButtonInteraction,
  handleRosterPostSettingsGroupSelectInteraction,
  handleRosterPostSettingsPlayerSelectInteraction,
  handleRosterPostSettingsUserSelectInteraction,
  handleRosterManageAccountSelectInteraction,
  handleRosterManageActionButtonInteraction,
  handleRosterManageGroupSelectInteraction,
  handleRosterManagePageButtonInteraction,
  handleRosterManageRosterSelectInteraction,
  handleRosterSignupButtonInteraction,
  handleRosterRemoveButtonInteraction,
  handleRosterSelectionMenuInteraction,
  handleRosterSelectionActionButtonInteraction,
  handleRosterPostRefreshButtonInteraction,
  handleRosterPostSettingsButtonInteraction,
  handleRosterPostSettingsMenuInteraction,
  handleRosterPostCustomizeMenuInteraction,
  handleRosterPostClearButtonInteraction,
  handleRosterManageWeightOpenButtonInteraction,
  handleRosterManageWeightModalSubmit,
  isRosterPostClearButtonCustomId,
  isRosterPostCustomizeColumnsMenuCustomId,
  isRosterPostCustomizeSortMenuCustomId,
  isRosterManageWeightOpenButtonCustomId,
  isRosterManageWeightModalCustomId,
} from "../commands/Roster";
import {
  isRosterSignupButtonCustomId,
  isRosterRemoveButtonCustomId,
  isRosterSelectionMenuCustomId,
  isRosterSelectionGroupMenuCustomId,
  isRosterSelectionActionButtonCustomId,
  isRosterPostRefreshButtonCustomId,
  isRosterPostSettingsButtonCustomId,
  isRosterPostSettingsMenuCustomId,
  isRosterReportPingButtonCustomId,
  isRosterPingActionButtonCustomId,
  isRosterPostUsersActionButtonCustomId,
  isRosterPostUsersGroupSelectMenuCustomId,
  isRosterPostUsersPlayerSelectMenuCustomId,
  isRosterManageAccountSelectMenuCustomId,
  isRosterManageActionButtonCustomId,
  isRosterManageGroupSelectMenuCustomId,
  isRosterManagePageButtonCustomId,
  isRosterManageRosterSelectMenuCustomId,
} from "../services/RosterService";
import {
  handleTodoPageButtonInteraction,
  handleTodoRefreshButtonInteraction,
  isTodoPageButtonCustomId,
  isTodoRefreshButtonCustomId,
} from "../commands/Todo";
import {
  handleDeferConfigResetChannelButtonInteraction,
  isDeferConfigResetChannelButtonCustomId,
} from "../commands/Defer";
import {
  handleRaidsButtonInteraction,
  handleRaidsIntelButtonInteraction,
  handleRaidsSelectMenuInteraction,
  handleRaidsIntelSelectMenuInteraction,
  isRaidsButtonCustomId,
  isRaidsIntelButtonCustomId,
  isRaidsSelectMenuCustomId,
  isRaidsIntelSelectMenuCustomId,
} from "../commands/Raids";
import { handleSayModalSubmit, isSayModalCustomId } from "../commands/Say";

const commandPermissionService = new CommandPermissionService();
const GLOBAL_POST_BUTTON_PREFIX = "post-channel";
const COMMANDS_WITH_CUSTOM_VISIBILITY = new Set([
  "help",
  "fwa",
  "layout",
  "compo",
  "emoji",
  "say",
]);

const registeredClients = new WeakSet<Client>();
const telemetryIngest = TelemetryIngestService.getInstance();

function isMissingBotPermissionsError(err: unknown): boolean {
  const code = (err as { code?: number } | null | undefined)?.code;
  return code === 50013 || code === 50001;
}

function getDiscordErrorCode(err: unknown): number | null {
  const code = (err as { code?: number } | null | undefined)?.code;
  return typeof code === "number" ? code : null;
}

function missingPermissionMessage(context: string): string {
  return `I couldn't complete ${context} because I'm missing one or more required Discord permissions. Please update my role permissions/channel overrides and retry.`;
}

function getRequestedVisibility(interaction: ChatInputCommandInteraction): "private" | "public" {
  try {
    const visibility = interaction.options.getString("visibility", false);
    return visibility === "public" ? "public" : "private";
  } catch {
    return "private";
  }
}

function getInteractionSubcommandPath(interaction: ChatInputCommandInteraction): string {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  if (group && sub) return `${group}:${sub}`;
  if (sub) return sub;
  return "";
}

function truncateDiagnosticText(input: string, maxLength = 220): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}...[len=${input.length}]`;
}

function safeDiagnosticJson(
  value: unknown,
  maxLength = 6000,
  stringLimit = 220,
): string {
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === "string") {
          return truncateDiagnosticText(current, stringLimit);
        }
        if (
          typeof current === "number" ||
          typeof current === "boolean" ||
          current === null
        ) {
          return current;
        }
        if (typeof current === "bigint") {
          return current.toString();
        }
        if (typeof current === "undefined") {
          return "[undefined]";
        }
        if (current instanceof Error) {
          return {
            name: current.name,
            message: truncateDiagnosticText(current.message, 220),
            stack: current.stack ? truncateDiagnosticText(current.stack, 1200) : null,
          };
        }
        if (typeof current === "object" && current !== null) {
          if (seen.has(current as object)) return "[Circular]";
          seen.add(current as object);
        }
        return current;
      },
      2,
    );
    if (!text) return "null";
    return text.length <= maxLength
      ? text
      : `${text.slice(0, maxLength)}...[len=${text.length}]`;
  } catch (error) {
    return truncateDiagnosticText(`"<unstringifiable:${formatError(error)}>"`, maxLength);
  }
}

function getDiscordRestErrorCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && /^[0-9]+$/.test(code)) return Number(code);
  return null;
}

function getDiscordRestErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  if (typeof status === "string" && /^[0-9]+$/.test(status)) return Number(status);
  return null;
}

function summarizeDiscordRestError(err: unknown): Record<string, unknown> {
  const error = err as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    code?: unknown;
    status?: unknown;
    method?: unknown;
    url?: unknown;
    rawError?: unknown;
    errors?: unknown;
    requestBody?: unknown;
    response?: { data?: unknown } | undefined;
    cause?: unknown;
  };
  const requestBody = error.requestBody as
    | {
        json?: unknown;
      }
    | undefined;
  const requestBodyJson = requestBody && typeof requestBody === "object" ? requestBody.json : undefined;
  const requestBodyJsonKeys =
    requestBodyJson && typeof requestBodyJson === "object" && !Array.isArray(requestBodyJson)
      ? Object.keys(requestBodyJson as Record<string, unknown>)
      : [];
  return {
    name: typeof error.name === "string" ? error.name : typeof err,
    message:
      typeof error.message === "string"
        ? truncateDiagnosticText(error.message, 500)
        : String(err ?? ""),
    stack: typeof error.stack === "string" ? truncateDiagnosticText(error.stack, 2000) : null,
    code: getDiscordRestErrorCode(err),
    status: getDiscordRestErrorStatus(err),
    method: typeof error.method === "string" ? error.method : null,
    url: typeof error.url === "string" ? error.url : null,
    rawError: error.rawError ?? null,
    errors: error.errors ?? null,
    requestBody: requestBody ?? null,
    requestBodyJsonKeys,
    responseData: error.response?.data ?? null,
    cause: error.cause ?? null,
  };
}

function logHandlerRunCheckpoint(input: {
  interaction: ChatInputCommandInteraction;
  runId: string;
  stage: "before_handler_run" | "after_handler_run";
  handlerName: string;
  runFnType?: string;
  runFnName?: string;
  handlerKeys?: string[];
}): void {
  console.log(
    `[interaction] stage=${input.stage} command=${input.interaction.commandName} subcommand=${getInteractionSubcommandPath(input.interaction)} handler=${input.handlerName} guild=${input.interaction.guildId ?? "DM"} user=${input.interaction.user.id} interaction=${input.interaction.id} runId=${input.runId}${input.runFnType ? ` runFnType=${input.runFnType}` : ""}${input.runFnName ? ` runFnName=${input.runFnName}` : ""}${input.handlerKeys ? ` handlerKeys=${input.handlerKeys.join(",")}` : ""}`,
  );
}

function logHandlerRunFailure(input: {
  interaction: ChatInputCommandInteraction;
  runId: string;
  handlerName: string;
  error: unknown;
}): void {
  console.error(
    `[interaction-error] stage=handler_run_failed command=${input.interaction.commandName} subcommand=${getInteractionSubcommandPath(input.interaction)} handler=${input.handlerName} guild=${input.interaction.guildId ?? "DM"} user=${input.interaction.user.id} interaction=${input.interaction.id} runId=${input.runId} deferred=${Boolean(input.interaction.deferred)} replied=${Boolean(input.interaction.replied)} error=${safeDiagnosticJson(summarizeDiscordRestError(input.error), 6000, 800)}`,
  );
}

function logHandlerRunBegin(input: {
  interaction: ChatInputCommandInteraction;
  runId: string;
  handlerName: string;
  runFnType: string;
  runFnName: string;
  handlerKeys: string[];
}): void {
  console.log(
    `[interaction] stage=handler_run_begin command=${input.interaction.commandName} subcommand=${getInteractionSubcommandPath(input.interaction)} handler=${input.handlerName} guild=${input.interaction.guildId ?? "DM"} user=${input.interaction.user.id} interaction=${input.interaction.id} runId=${input.runId} runFnType=${input.runFnType} runFnName=${input.runFnName} handlerKeys=${input.handlerKeys.join(",")}`,
  );
}

function logHandlerRunDone(input: {
  interaction: ChatInputCommandInteraction;
  runId: string;
  handlerName: string;
  durationMs: number;
}): void {
  console.log(
    `[interaction] stage=handler_run_done command=${input.interaction.commandName} subcommand=${getInteractionSubcommandPath(input.interaction)} handler=${input.handlerName} guild=${input.interaction.guildId ?? "DM"} user=${input.interaction.user.id} interaction=${input.interaction.id} runId=${input.runId} durationMs=${input.durationMs}`,
  );
}

function logHandlerRunStillRunning(input: {
  interaction: ChatInputCommandInteraction;
  runId: string;
  handlerName: string;
  thresholdMs: number;
  durationMs: number;
  activeHandleSummary?: string;
}): void {
  console.log(
    `[interaction] stage=handler_run_still_running command=${input.interaction.commandName} subcommand=${getInteractionSubcommandPath(input.interaction)} handler=${input.handlerName} guild=${input.interaction.guildId ?? "DM"} user=${input.interaction.user.id} interaction=${input.interaction.id} runId=${input.runId} thresholdMs=${input.thresholdMs} durationMs=${input.durationMs}${input.activeHandleSummary ? ` activeHandleSummary=${input.activeHandleSummary}` : ""}`,
  );
}

function buildActiveHandleSummary(): string {
  const processAny = process as typeof process & {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  const handles = typeof processAny._getActiveHandles === "function" ? processAny._getActiveHandles() : [];
  const requests = typeof processAny._getActiveRequests === "function" ? processAny._getActiveRequests() : [];
  const handleTypes = [...new Set(handles.slice(0, 8).map((handle) => {
    if (!handle || typeof handle !== "object") return typeof handle;
    return (handle as { constructor?: { name?: string } }).constructor?.name ?? "Object";
  }))];
  return safeDiagnosticJson({
    handleCount: handles.length,
    requestCount: requests.length,
    handleTypes,
  }, 2000, 200);
}

async function handleBestEffortSelectMenuFailure(
  interaction: StringSelectMenuInteraction,
  context: string,
  fallbackContent: string,
  err: unknown,
): Promise<void> {
  const code = getDiscordErrorCode(err);
  if (code === 10062) {
    console.warn(`${context} expired before response (10062).`);
    return;
  }

  console.error(`${context} failed: ${formatError(err)}`);
  const payload = {
    ephemeral: true,
    content: fallbackContent,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
      return;
    }

    await interaction.reply(payload);
  } catch (responseError) {
    const responseCode = getDiscordErrorCode(responseError);
    if (responseCode === 10062) {
      console.warn(`${context} fallback response expired before response (10062).`);
      return;
    }

    console.error(`${context} fallback response failed: ${formatError(responseError)}`);
  }
}

function buildGlobalPostButton(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${GLOBAL_POST_BUTTON_PREFIX}:${userId}`)
      .setLabel("Post to Channel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function maybeAttachPostButton(
  payload: unknown,
  userId: string,
  isPublic: boolean
): unknown {
  if (isPublic) return payload;

  const normalized =
    typeof payload === "string"
      ? { content: payload }
      : payload && typeof payload === "object"
        ? { ...(payload as Record<string, unknown>) }
        : payload;

  if (!normalized || typeof normalized !== "object") return normalized;

  const currentComponents = Array.isArray((normalized as { components?: unknown[] }).components)
    ? ([...(normalized as { components: unknown[] }).components] as unknown[])
    : [];

  if (currentComponents.length >= 5) {
    return normalized;
  }

  currentComponents.push(buildGlobalPostButton(userId));
  return {
    ...normalized,
    components: currentComponents,
  };
}

function coerceInteractionResponseVisibility(payload: unknown, isPublic: boolean): unknown {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as Record<string, unknown>),
    ephemeral: !isPublic,
  };
}

function isGlobalPostButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${GLOBAL_POST_BUTTON_PREFIX}:`);
}

function parseGlobalPostButtonCustomId(customId: string): { userId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== GLOBAL_POST_BUTTON_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  if (!userId) return null;
  return { userId };
}

function normalizeQueueSourceSegment(input: string | null | undefined, fallback: string): string {
  const normalized = String(input ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .slice(0, 80);
  return normalized || fallback;
}

async function runWithInteractiveQueueContext<T>(
  source: string,
  run: () => Promise<T>,
): Promise<T> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source: normalizeQueueSourceSegment(source, "interactive"),
    },
    run,
  );
}

export default (client: Client, cocService: CoCService): void => {
  if (registeredClients.has(client)) {
    console.warn("interactionCreate already registered, skipping");
    return;
  }

  registeredClients.add(client);

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      await runWithInteractiveQueueContext(
        `autocomplete:${interaction.commandName}`,
        () => handleAutocomplete(interaction),
      );
      return;
    }

  if (interaction.isButton()) {
    try {
      await runWithInteractiveQueueContext(
        `button:${interaction.customId.split(":")[0] ?? "unknown"}`,
        () => handleButtonInteraction(interaction, cocService),
      );
    } catch (err) {
      console.error(`Button interaction failed: ${formatError(err)}`);
      const code = getDiscordErrorCode(err);
      if (code === 10062) {
        console.warn("Button interaction expired before response (10062).");
        return;
      }
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            ephemeral: true,
            content: "This interaction expired. Please run the command again.",
          })
          .catch(() => undefined);
      }
    }
    return;
  }

  if (interaction.isUserSelectMenu()) {
    await runWithInteractiveQueueContext(
      `select:${interaction.customId.split(":")[0] ?? "unknown"}`,
      () => handleRosterPostSettingsUserSelectInteraction(interaction),
    );
    return;
  }

  if (interaction.isStringSelectMenu()) {
    await runWithInteractiveQueueContext(
      `select:${interaction.customId.split(":")[0] ?? "unknown"}`,
      () => handleSelectMenuInteraction(interaction, cocService),
    );
    return;
  }

    if (interaction.isModalSubmit()) {
      await runWithInteractiveQueueContext(
        `modal:${interaction.customId.split(":")[0] ?? "unknown"}`,
        () => handleModalSubmit(interaction, cocService),
      );
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const user = `${interaction.user.tag} (${interaction.user.id})`;
    const guild = interaction.guild
      ? `${interaction.guild.name} (${interaction.guild.id})`
      : "DM";
    const options = interaction.options.data
      .map((opt) => `${opt.name}=${String(opt.value ?? "")}`)
      .join(", ");

    dozzleLog.info(
      `[cmd] user=${user} guild=${guild} command=/${interaction.commandName}` +
        (options ? ` options={${options}}` : "")
    );
    if (interaction.commandName === "compo") {
      const sub = interaction.options.getSubcommand(false) ?? "unknown";
      dozzleLog.debug(
        `[compo-command] stage=interaction_received command=compo subcommand=${sub} guild=${interaction.guildId ?? "DM"} user=${interaction.user.id}`
      );
    }

    await runWithInteractiveQueueContext(
      `slash:${interaction.commandName}:${getInteractionSubcommandPath(interaction) || "root"}`,
      () => handleSlashCommand(client, interaction, cocService),
    );
  });
};

const handleSelectMenuInteraction = async (
  interaction: StringSelectMenuInteraction,
  cocService: CoCService
): Promise<void> => {
  if (isRosterSelectionMenuCustomId(interaction.customId)) {
    try {
      await handleRosterSelectionMenuInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster selection menu",
        "Failed to update roster selection.",
        err,
      );
    }
    return;
  }

  if (isRosterManageAccountSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRosterManageAccountSelectInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster manage account menu",
        "Failed to update roster manage accounts.",
        err,
      );
    }
    return;
  }

  if (isRosterManageGroupSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRosterManageGroupSelectInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster manage group menu",
        "Failed to update roster manage groups.",
        err,
      );
    }
    return;
  }

  if (isRosterManageRosterSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRosterManageRosterSelectInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster manage roster menu",
        "Failed to update roster manage target roster.",
        err,
      );
    }
    return;
  }

  if (isRosterSelectionGroupMenuCustomId(interaction.customId)) {
    try {
      await handleRosterSelectionMenuInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster selection group menu",
        "Failed to update roster selection.",
        err,
      );
    }
    return;
  }

  if (isRosterPostUsersPlayerSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRosterPostSettingsPlayerSelectInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster settings player menu",
        "Failed to update roster settings.",
        err,
      );
    }
    return;
  }

  if (isRosterPostUsersGroupSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRosterPostSettingsGroupSelectInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster settings group menu",
        "Failed to update roster settings.",
        err,
      );
    }
    return;
  }

  if (isRosterPostSettingsMenuCustomId(interaction.customId)) {
    try {
      await handleRosterPostSettingsMenuInteraction(interaction, cocService);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster settings menu",
        "Failed to update roster settings.",
        err,
      );
    }
    return;
  }

  if (isRosterPostCustomizeColumnsMenuCustomId(interaction.customId) || isRosterPostCustomizeSortMenuCustomId(interaction.customId)) {
    try {
      await handleRosterPostCustomizeMenuInteraction(interaction, cocService);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Roster customize menu",
        "Failed to update roster customization.",
        err,
      );
    }
    return;
  }

  if (isCwlRotationImportSelectMenuCustomId(interaction.customId)) {
    try {
      await handleCwlRotationImportSelectMenuInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "CWL rotation import select menu",
        "Failed to update the CWL rotation import review.",
        err,
      );
    }
    return;
  }

  if (isCwlRotationShowSelectMenuCustomId(interaction.customId)) {
    try {
      await handleCwlRotationShowSelectMenuInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "CWL rotation show select menu",
        "Failed to update the CWL rotation show overview.",
        err,
      );
    }
    return;
  }

  if (isRaidsSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRaidsSelectMenuInteraction(interaction, cocService);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Raids dashboard select menu",
        "Failed to update the raids dashboard.",
        err,
      );
    }
    return;
  }

  if (isRaidsIntelSelectMenuCustomId(interaction.customId)) {
    try {
      await handleRaidsIntelSelectMenuInteraction(interaction, cocService);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Raids intel select menu",
        "Failed to update the raids intel view.",
        err,
      );
    }
    return;
  }

  if (isLinkListSelectCustomId(interaction.customId)) {
    try {
      await handleLinkListSelectMenu(interaction, cocService);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Link list select menu",
        "Failed to update link list view.",
        err,
      );
    }
    return;
  }

  if (isFwaMatchSelectCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSelectMenu(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "FWA match select menu",
        "Failed to open clan match view.",
        err,
      );
    }
    return;
  }

  if (isCompoAdviceClanSelectMenuCustomId(interaction.customId)) {
    try {
      await handleCompoAdviceClanSelectMenuInteraction(interaction);
    } catch (err) {
      await handleBestEffortSelectMenuFailure(
        interaction,
        "Compo advice clan select menu",
        "Failed to update compo advice clan selection.",
        err,
      );
    }
    return;
  }
};

const handleButtonInteraction = async (
  interaction: Interaction,
  cocService: CoCService
): Promise<void> => {
  if (!interaction.isButton()) return;

  if (isTodoPageButtonCustomId(interaction.customId)) {
    try {
      await handleTodoPageButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Todo page button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update todo page.",
        });
      }
    }
    return;
  }

  if (isTodoRefreshButtonCustomId(interaction.customId)) {
    try {
      await handleTodoRefreshButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Todo refresh button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh todo data.",
        });
      }
    }
    return;
  }

  if (isRaidsButtonCustomId(interaction.customId)) {
    try {
      await handleRaidsButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Raids dashboard button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update the raids dashboard.",
        });
      }
    }
    return;
  }

  if (isRaidsIntelButtonCustomId(interaction.customId)) {
    try {
      await handleRaidsIntelButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Raids intel button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update the raids intel view.",
        });
      }
    }
    return;
  }

  if (isCompoHeatMapRefCopyButtonCustomId(interaction.customId)) {
    try {
      await handleCompoHeatMapRefCopyButton(interaction);
    } catch (err) {
      console.error(`Compo heatmapref copy button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to build the HeatMapRef copy text.",
        });
      }
    }
    return;
  }

  if (isLinkListSortButtonCustomId(interaction.customId)) {
    try {
      await handleLinkListSortButton(interaction, cocService);
    } catch (err) {
      console.error(`Link list sort button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update link list sort.",
        });
      }
    }
    return;
  }

  if (isLinkEmbedAccountButtonCustomId(interaction.customId)) {
    try {
      await handleLinkEmbedButtonInteraction(interaction);
    } catch (err) {
      console.error(`Link embed button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open link modal.",
        });
      }
    }
    return;
  }

  if (isReminderLinkButtonCustomId(interaction.customId)) {
    try {
      await handleReminderLinkButtonInteraction(interaction);
    } catch (err) {
      console.error(`Reminder link button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open reminder link confirmation.",
        });
      }
    }
    return;
  }

  if (isReminderLinkConfirmButtonCustomId(interaction.customId)) {
    try {
      await handleReminderLinkConfirmButtonInteraction(interaction);
    } catch (err) {
      console.error(`Reminder link confirm button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to confirm reminder link.",
        });
      }
    }
    return;
  }

  if (isReminderLinkCancelButtonCustomId(interaction.customId)) {
    try {
      await handleReminderLinkCancelButtonInteraction(interaction);
    } catch (err) {
      console.error(`Reminder link cancel button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to cancel reminder link.",
        });
      }
    }
    return;
  }

  if (isCwlRotationImportButtonCustomId(interaction.customId)) {
    try {
      await handleCwlRotationImportButtonInteraction(interaction);
    } catch (err) {
      console.error(`CWL rotation import preview button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update the CWL rotation import preview.",
        });
      }
    }
    return;
  }

  if (isCwlRotationShowButtonCustomId(interaction.customId)) {
    try {
      await handleCwlRotationShowButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`CWL rotation show button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update the CWL rotation show view.",
        });
      }
    }
    return;
  }

  if (isRosterSignupButtonCustomId(interaction.customId)) {
    try {
      await handleRosterSignupButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`CWL roster signup button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update the CWL signup roster.",
        });
      }
    }
    return;
  }

  if (isRosterPostRefreshButtonCustomId(interaction.customId)) {
    try {
      await handleRosterPostRefreshButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster refresh button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh the roster post.",
        });
      }
    }
    return;
  }

  if (isRosterManagePageButtonCustomId(interaction.customId)) {
    try {
      await handleRosterManagePageButtonInteraction(interaction);
    } catch (err) {
      console.error(`Roster manage page button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update roster manage session.",
        });
      }
    }
    return;
  }

  if (isRosterManageActionButtonCustomId(interaction.customId)) {
    try {
      await handleRosterManageActionButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster manage action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update roster manage session.",
        });
      }
    }
    return;
  }

  if (isRosterManageWeightOpenButtonCustomId(interaction.customId)) {
    try {
      await handleRosterManageWeightOpenButtonInteraction(interaction);
    } catch (err) {
      console.error(`Roster weight button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open roster weight input.",
        });
      }
    }
    return;
  }

  if (isRosterRemoveButtonCustomId(interaction.customId)) {
    try {
      await handleRosterRemoveButtonInteraction(interaction);
    } catch (err) {
      console.error(`CWL roster remove button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open roster removal.",
        });
      }
    }
    return;
  }

  if (isRosterPostSettingsButtonCustomId(interaction.customId)) {
    try {
      await handleRosterPostSettingsButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster settings button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open roster settings.",
        });
      }
    }
    return;
  }

  if (isRosterPostUsersActionButtonCustomId(interaction.customId)) {
    try {
      await handleRosterPostSettingsActionButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster settings user action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update roster settings.",
        });
      }
    }
    return;
  }

  if (isRosterReportPingButtonCustomId(interaction.customId)) {
    try {
      await handleRosterReportPingButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster report ping button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open roster ping.",
        });
      }
    }
    return;
  }

  if (isRosterPingActionButtonCustomId(interaction.customId)) {
    try {
      await handleRosterPingActionButtonInteraction(interaction);
    } catch (err) {
      console.error(`Roster ping confirmation button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to post the roster ping.",
        });
      }
    }
    return;
  }

  if (isRosterPostClearButtonCustomId(interaction.customId)) {
    try {
      await handleRosterPostClearButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster clear confirmation button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to clear the roster.",
        });
      }
    }
    return;
  }

  if (isRosterSelectionActionButtonCustomId(interaction.customId)) {
    try {
      await handleRosterSelectionActionButtonInteraction(interaction, cocService);
    } catch (err) {
      console.error(`Roster selection action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update roster selection.",
        });
      }
    }
    return;
  }

  if (isGlobalPostButtonCustomId(interaction.customId)) {
    const parsed = parseGlobalPostButtonCustomId(interaction.customId);
    if (!parsed) return;

    if (interaction.user.id !== parsed.userId) {
      await interaction.reply({
        ephemeral: true,
        content: "Only the command requester can use this button.",
      });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isTextBased() || !("send" in channel)) {
      await interaction.reply({
        ephemeral: true,
        content: "Could not post to this channel.",
      });
      return;
    }

    try {
      await channel.send({
        content: truncateDiscordContent(interaction.message.content || ""),
        embeds: interaction.message.embeds.map((embed) => embed.toJSON()),
      });
      await interaction.reply({
        ephemeral: true,
        content: "Posted to channel.",
      });
    } catch (err) {
      console.error(`Global post button failed: ${formatError(err)}`);
      await interaction.reply({
        ephemeral: true,
        content: "Failed to post to channel. Check bot permissions and try again.",
      });
    }
    return;
  }

  if (isDeferConfigResetChannelButtonCustomId(interaction.customId)) {
    try {
      await handleDeferConfigResetChannelButtonInteraction(interaction);
    } catch (err) {
      console.error(`Defer config reset-channel button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to reset the defer channel override.",
        });
      }
    }
    return;
  }

  if (isPointsPostButtonCustomId(interaction.customId)) {
    try {
      await handlePointsPostButton(interaction);
    } catch (err) {
      console.error(`Points post button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to post points message to channel.",
        });
      }
    }
  }

  if (isFwaBaseSwapSplitPostButtonCustomId(interaction.customId)) {
    try {
      await handleFwaBaseSwapSplitPostButton(interaction);
    } catch (err) {
      console.error(`FWA base-swap split-post button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to process base-swap split-post action.",
        });
      }
    }
    return;
  }

  if (isFwaComplianceViewButtonCustomId(interaction.customId)) {
    try {
      await handleFwaComplianceViewButton(interaction);
    } catch (err) {
      console.error(`FWA compliance view button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to update compliance view.",
        });
      }
    }
    return;
  }

  if (isFwaMatchCopyButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchCopyButton(interaction);
    } catch (err) {
      console.error(`FWA match copy button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to toggle match view.",
        });
      }
    }
  }

  if (isFwaMatchTieBreakerButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchTieBreakerButton(interaction);
    } catch (err) {
      console.error(`FWA match tie-breaker button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open tie-breaker rules.",
        });
      }
    }
  }

  if (isFwaMatchTypeActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchTypeActionButton(interaction);
    } catch (err) {
      console.error(`FWA match type action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to apply match type update.",
        });
      }
    }
  }

  if (isFwaMatchTypeEditButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchTypeEditButton(interaction);
    } catch (err) {
      console.error(`FWA match type edit button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open match type options.",
        });
      }
    }
  }

  if (isFwaOutcomeActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaOutcomeActionButton(interaction);
    } catch (err) {
      console.error(`FWA outcome action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to reverse expected outcome.",
        });
      }
    }
  }

  if (isFwaMatchAllianceButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchAllianceButton(interaction, cocService);
    } catch (err) {
      console.error(`FWA match alliance button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open alliance view.",
        });
      }
    }
  }

  if (isFwaMatchSyncActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSyncActionButton(interaction);
    } catch (err) {
      console.error(`FWA match sync action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to sync points-site data.",
        });
      }
    }
  }

  if (isFwaMatchSkipSyncActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSkipSyncActionButton(interaction);
    } catch (err) {
      console.error(`FWA match skip-sync action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to apply skip-sync action.",
        });
      }
    }
  }

  if (isFwaMatchSkipSyncConfirmButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSkipSyncConfirmButton(interaction);
    } catch (err) {
      console.error(`FWA match skip-sync confirm button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to confirm skip-sync action.",
        });
      }
    }
  }

  if (isFwaMatchSkipSyncUndoButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSkipSyncUndoButton(interaction);
    } catch (err) {
      console.error(`FWA match skip-sync undo button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to undo skip-sync action.",
        });
      }
    }
  }

  if (isFwaMatchSendMailButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSendMailButton(interaction);
    } catch (err) {
      console.error(`FWA match send-mail button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open war mail preview.",
        });
      }
    }
  }

  if (isFwaMailGateResumeButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailGateResumeButton(interaction);
    } catch (err) {
      console.error(`FWA mail gate resume button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to continue in match view.",
        });
      }
    }
  }

  if (isFwaMailConfirmButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailConfirmButton(interaction);
    } catch (err) {
      console.error(`FWA mail confirm button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to send war mail.",
        });
      }
    }
  }

  if (isFwaMailConfirmNoPingButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailConfirmNoPingButton(interaction);
    } catch (err) {
      console.error(`FWA mail confirm-no-ping button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to send war mail.",
        });
      }
    }
  }

  if (isFwaMailBackButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailBackButton(interaction);
    } catch (err) {
      console.error(`FWA mail back button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to restore the match view.",
        });
      }
    }
  }

  if (isFwaMailRefreshButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailRefreshButton(interaction);
    } catch (err) {
      console.error(`FWA mail refresh button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh war mail.",
        });
      }
    }
  }

  if (isNotifyWarRefreshButtonCustomId(interaction.customId)) {
    try {
      await handleNotifyWarRefreshButton(interaction);
    } catch (err) {
      console.error(`Notify war refresh button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh battle-day embed.",
        });
      }
    }
  }

  if (isNotifyWarEndedViewButtonCustomId(interaction.customId)) {
    try {
      await handleNotifyWarEndedViewButton(interaction);
    } catch (err) {
      console.error(`Notify war-ended view button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "This war-end view expired.",
        });
      }
    }
  }

  if (isNotifyWarPreviewPostButtonCustomId(interaction.customId)) {
    try {
      await handleNotifyWarPreviewPostButton(interaction, cocService);
    } catch (err) {
      console.error(`Notify war preview post button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to post previewed war embed.",
        });
      }
    }
  }

  if (isCompoRefreshButtonCustomId(interaction.customId)) {
    try {
      await handleCompoRefreshButton(interaction, cocService);
    } catch (err) {
      console.error(`Compo refresh button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh compo output.",
        });
      }
    }
  }
};

const handleModalSubmit = async (
  interaction: ModalSubmitInteraction,
  _cocService: CoCService,
): Promise<void> => {
  const isPostModal = isPostModalCustomId(interaction.customId);
  const isRecruitmentModal = isRecruitmentModalCustomId(interaction.customId);
  const isLinkEmbedModal = isLinkEmbedModalCustomId(interaction.customId);
  const isSayModal = isSayModalCustomId(interaction.customId);
  const isRosterWeightModal = isRosterManageWeightModalCustomId(interaction.customId);
  if (!isPostModal && !isRecruitmentModal && !isLinkEmbedModal && !isSayModal && !isRosterWeightModal) {
    return;
  }

  try {
    if (isLinkEmbedModal) {
      await handleLinkEmbedModalSubmit(interaction);
      return;
    }

    if (isSayModal) {
      const allowed = await commandPermissionService.canUseAnyTarget(["say"], interaction);
      if (!allowed) {
        await interaction.reply({
          content: "You do not have permission to use /say.",
          ephemeral: true,
        });
        return;
      }
      await handleSayModalSubmit(interaction);
      return;
    }

    if (isRosterWeightModal) {
      await handleRosterManageWeightModalSubmit(interaction, _cocService);
      return;
    }

    const targets = isPostModal
      ? ["sync:time:post", "sync"]
      : ["recruitment:edit", "recruitment"];
    const allowed = await commandPermissionService.canUseAnyTarget(targets, interaction);
    if (!allowed) {
      await interaction.reply({
        content: isPostModal
          ? "You do not have permission to use /sync."
          : "You do not have permission to use /recruitment.",
        ephemeral: true,
      });
      return;
    }

    if (isPostModal) {
      await handlePostModalSubmit(interaction);
      return;
    }
    await handleRecruitmentModalSubmit(interaction);
  } catch (err) {
    console.error(`Modal submit failed: ${formatError(err)}`);
    const message = isMissingBotPermissionsError(err)
      ? missingPermissionMessage("that modal action")
      : "Something went wrong.";

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: truncateDiscordContent(message),
        ephemeral: true,
      });
      return;
    }

    if (interaction.deferred) {
      await interaction.editReply(truncateDiscordContent(message));
    }
  }
};

const handleAutocomplete = async (
  interaction: AutocompleteInteraction
): Promise<void> => {
  const slashCommand = Commands.find((c) => c.name === interaction.commandName);
  if (!slashCommand?.autocomplete) {
    try {
      await interaction.respond([]);
    } catch {
      // no-op
    }
    return;
  }

  try {
    await slashCommand.autocomplete(interaction);
  } catch (err) {
    console.error(`Autocomplete failed: ${formatError(err)}`);
    try {
      await interaction.respond([]);
    } catch {
      // no-op
    }
  }
};

const handleSlashCommand = async (
  client: Client,
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> => {
  const slashCommand = Commands.find((c) => c.name === interaction.commandName);

  if (!slashCommand) {
    try {
      await interaction.reply({
        ephemeral: true,
        content: truncateDiscordContent("An error has occurred"),
      });
    } catch {
      // no-op
    }
    return;
  }
  if (interaction.commandName === "compo") {
    const sub = interaction.options.getSubcommand(false) ?? "unknown";
    console.log(
      `[compo-command] stage=handler_resolved command=compo subcommand=${sub} handler=${slashCommand.name}.run`
    );
  }

  const commandName = interaction.commandName;
  const subcommand = getInteractionSubcommandPath(interaction);
  const runId = `${interaction.id}:${Date.now().toString(36)}`;
  const startedAtMs = Date.now();
  let lifecycleFinalized = false;

  const recordSuccess = () => {
    if (lifecycleFinalized) return;
    lifecycleFinalized = true;
    telemetryIngest.recordCommandLifecycle({
      status: "success",
      guildId: interaction.guildId ?? "global",
      userId: interaction.user.id,
      commandName,
      subcommand,
      runId,
      interactionId: interaction.id,
      durationMs: Date.now() - startedAtMs,
    });
  };

  const recordFailure = (input: {
    errorCategory: string;
    errorCode: string;
    timeout: boolean;
  }) => {
    if (lifecycleFinalized) return;
    lifecycleFinalized = true;
    telemetryIngest.recordCommandLifecycle({
      status: "failure",
      guildId: interaction.guildId ?? "global",
      userId: interaction.user.id,
      commandName,
      subcommand,
      runId,
      interactionId: interaction.id,
      durationMs: Date.now() - startedAtMs,
      errorCategory: input.errorCategory,
      errorCode: input.errorCode,
      timeout: input.timeout,
    });
  };

  telemetryIngest.recordCommandLifecycle({
    status: "start",
    guildId: interaction.guildId ?? "global",
    userId: interaction.user.id,
    commandName,
    subcommand,
    runId,
    interactionId: interaction.id,
  });

  try {
    await runWithTelemetryContext(
      {
        runId,
        guildId: interaction.guildId ?? "global",
        userId: interaction.user.id,
        commandName,
        subcommand,
        interactionId: interaction.id,
      },
      async () => {
        const permissionStartedAtMs = Date.now();
        const targets = getCommandTargetsFromInteraction(interaction);
        const allowed = await commandPermissionService.canUseAnyTarget(
          targets,
          interaction
        );
        telemetryIngest.recordStageTiming({
          stage: "permission_check",
          status: allowed ? "success" : "failure",
          guildId: interaction.guildId ?? "global",
          commandName,
          subcommand,
          runId,
          durationMs: Date.now() - permissionStartedAtMs,
        });

        if (!allowed) {
          recordFailure({
            errorCategory: "permission",
            errorCode: "PERMISSION_DENIED",
            timeout: false,
          });
          const permissionMessage = `You do not have permission to use /${interaction.commandName}.`;
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: permissionMessage,
            });
          } else {
            await interaction.reply({
              content: permissionMessage,
              ephemeral: true,
            });
          }
          return;
        }

        const autoVisibilityEnabled = !COMMANDS_WITH_CUSTOM_VISIBILITY.has(
          interaction.commandName
        );
        if (autoVisibilityEnabled) {
          const visibility = getRequestedVisibility(interaction);
          const isPublic = visibility === "public";
          const originalDeferReply = interaction.deferReply.bind(interaction);
          const originalReply = interaction.reply.bind(interaction);
          const originalEditReply = interaction.editReply.bind(interaction);
          const originalFollowUp = interaction.followUp.bind(interaction);

          (interaction as any).deferReply = async (options?: Record<string, unknown>) =>
            originalDeferReply({
              ...(options ?? {}),
              ephemeral: !isPublic,
            });

          (interaction as any).reply = async (options: unknown) =>
            originalReply(
              maybeAttachPostButton(
                coerceInteractionResponseVisibility(options, isPublic),
                interaction.user.id,
                isPublic
              ) as
                | string
                | Record<string, unknown>
            );

          (interaction as any).editReply = async (options: unknown) =>
            originalEditReply(
              maybeAttachPostButton(options, interaction.user.id, isPublic) as
                | string
                | Record<string, unknown>
            );

          (interaction as any).followUp = async (options: unknown) =>
            originalFollowUp(
              maybeAttachPostButton(
                coerceInteractionResponseVisibility(options, isPublic),
                interaction.user.id,
                isPublic
              ) as
                | string
                | Record<string, unknown>
            );
        }

        const executionStartedAtMs = Date.now();
        const handlerName = `${slashCommand.name}.run`;
        const shouldWatchHandlerRun = interaction.commandName === "compo";
        const handlerRunWatchdogTimers: ReturnType<typeof setTimeout>[] = [];
        let handlerRunSettled = false;
        const clearHandlerRunWatchdogTimers = () => {
          while (handlerRunWatchdogTimers.length > 0) {
            const timer = handlerRunWatchdogTimers.pop();
            if (timer) clearTimeout(timer);
          }
        };
        const scheduleHandlerRunWatchdog = (thresholdMs: number) => {
          if (!shouldWatchHandlerRun) return;
          const timer = setTimeout(() => {
            if (handlerRunSettled) return;
            logHandlerRunStillRunning({
              interaction,
              runId,
              handlerName,
              thresholdMs,
              durationMs: Date.now() - executionStartedAtMs,
              activeHandleSummary:
                thresholdMs >= 8000 ? buildActiveHandleSummary() : undefined,
            });
          }, thresholdMs);
          handlerRunWatchdogTimers.push(timer);
        };
        scheduleHandlerRunWatchdog(3000);
        scheduleHandlerRunWatchdog(8000);
        scheduleHandlerRunWatchdog(15000);
        scheduleHandlerRunWatchdog(30000);
        try {
          const runFn = (slashCommand as { run?: unknown }).run;
          const runFnType = typeof runFn;
          const runFnName = runFnType === "function" ? (runFn as { name?: string }).name || "" : "";
          const handlerKeys = Object.keys(slashCommand as unknown as Record<string, unknown>).sort();
          if (interaction.commandName === "compo") {
            console.log(
              `[interaction] stage=before_handler_run command=compo subcommand=${subcommand} handler=${handlerName} guild=${interaction.guildId ?? "DM"} user=${interaction.user.id} interaction=${interaction.id} runId=${runId} runFnType=${runFnType} runFnName=${runFnName} handlerKeys=${handlerKeys.join(",")}`,
            );
            logHandlerRunBegin({
              interaction,
              runId,
              handlerName,
              runFnType,
              runFnName,
              handlerKeys,
            });
          }
          if (runFnType !== "function") {
            throw new TypeError(`Handler ${handlerName} is not callable.`);
          }
          await (runFn as (
            client: Client,
            interaction: ChatInputCommandInteraction,
            cocService: CoCService,
          ) => Promise<void>).call(slashCommand, client, interaction, cocService);
          handlerRunSettled = true;
          clearHandlerRunWatchdogTimers();
          if (interaction.commandName === "compo") {
            logHandlerRunDone({
              interaction,
              runId,
              handlerName,
              durationMs: Date.now() - executionStartedAtMs,
            });
            console.log(
              `[interaction] stage=after_handler_run command=compo subcommand=${subcommand} handler=${handlerName} guild=${interaction.guildId ?? "DM"} user=${interaction.user.id} interaction=${interaction.id} runId=${runId} runFnType=${runFnType} runFnName=${runFnName}`,
            );
          }
          telemetryIngest.recordStageTiming({
            stage: "command_execute",
            status: "success",
            guildId: interaction.guildId ?? "global",
            commandName,
            subcommand,
            runId,
            durationMs: Date.now() - executionStartedAtMs,
          });
          recordSuccess();
        } catch (err) {
          handlerRunSettled = true;
          clearHandlerRunWatchdogTimers();
          if (interaction.commandName === "compo") {
            logHandlerRunFailure({
              interaction,
              runId,
              handlerName,
              error: err,
            });
          }
          telemetryIngest.recordStageTiming({
            stage: "command_execute",
            status: "failure",
            guildId: interaction.guildId ?? "global",
            commandName,
            subcommand,
            runId,
            durationMs: Date.now() - executionStartedAtMs,
          });
          const failure = toFailureTelemetry(err);
          recordFailure({
            errorCategory: failure.errorCategory,
            errorCode: failure.errorCode,
            timeout: failure.timeout,
          });
          throw err;
        }
      }
    );
  } catch (err) {
    if (!lifecycleFinalized) {
      const failure = toFailureTelemetry(err);
      recordFailure({
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
    }
    dozzleLog.error(`Command failed: ${formatError(err)}`);
    const message = isMissingBotPermissionsError(err)
      ? missingPermissionMessage(`/${interaction.commandName}`)
      : "Something went wrong.";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(truncateDiscordContent(message));
        return;
      }

      await interaction.reply({
        content: truncateDiscordContent(message),
        ephemeral: true,
      });
    } catch (responseErr) {
      const code = getDiscordErrorCode(responseErr);
      // 10062 Unknown interaction: token expired/invalid; cannot recover.
      if (code === 10062) {
        dozzleLog.warn(
          `Failed to send error response for /${interaction.commandName}: interaction expired (10062).`
        );
        return;
      }
      // 40060 already acknowledged: try editReply as final fallback.
      if (code === 40060) {
        await interaction
          .editReply(truncateDiscordContent(message))
          .catch(() => undefined);
        return;
      }

      dozzleLog.error(
        `Failed to send error response for /${interaction.commandName}: ${formatError(responseErr)}`
      );
    }
  }
};
