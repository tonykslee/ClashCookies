import type { StringSelectMenuInteraction } from "discord.js";
import {
  CommandPermissionService,
} from "./CommandPermissionService";
import {
  parseSyncRetrospectiveClanSelectCustomId,
} from "./SyncRetrospectiveInteractionIds";
import {
  buildSyncRetrospectiveClanDetailEmbeds,
  hasSyncRetrospectiveData,
} from "./SyncRetrospectiveViewService";
import {
  SyncRetrospectiveService,
  type SyncRetrospectiveResult,
} from "./SyncRetrospectiveService";
import { normalizeTag } from "./war-events/core";

type PermissionReader = Pick<CommandPermissionService, "canUseAnyTarget">;
type RetrospectiveReader = Pick<SyncRetrospectiveService, "getBySyncNumber">;

export type SyncRetrospectiveClanSelectDependencies = {
  permissionService?: PermissionReader;
  retrospectiveService?: RetrospectiveReader;
};

function selectedClanTag(interaction: StringSelectMenuInteraction): string | null {
  if (interaction.values.length !== 1) return null;
  const value = interaction.values[0]?.trim() ?? "";
  if (!value) return null;
  const tag = normalizeTag(value);
  return /^#[A-Z0-9]+$/.test(tag) ? tag : null;
}

/** Purpose: serve one authorized, ephemeral, DB-first retrospective clan drilldown. */
export async function handleSyncRetrospectiveClanSelect(
  interaction: StringSelectMenuInteraction,
  dependencies: SyncRetrospectiveClanSelectDependencies = {},
): Promise<void> {
  const parsed = parseSyncRetrospectiveClanSelectCustomId(interaction.customId);
  if (!parsed) return;

  if (!interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This retrospective is only available inside a server.",
    });
    return;
  }

  const permissionService = dependencies.permissionService ?? new CommandPermissionService();
  const allowed = await permissionService.canUseAnyTarget(["sync:retrospective"], interaction);
  if (!allowed) {
    await interaction.reply({
      ephemeral: true,
      content: "You do not have permission to view sync retrospective details.",
    });
    return;
  }

  const clanTag = selectedClanTag(interaction);
  if (!clanTag) {
    await interaction.reply({
      ephemeral: true,
      content: "Select exactly one valid clan to view retrospective details.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const service = dependencies.retrospectiveService ?? new SyncRetrospectiveService();
  const result: SyncRetrospectiveResult = await service.getBySyncNumber({
    guildId: interaction.guildId,
    syncNumber: parsed.syncNumber,
  });

  if (!hasSyncRetrospectiveData(result)) {
    await interaction.editReply(`Sync #${parsed.syncNumber} retrospective data is no longer available.`);
    return;
  }

  const clan = result.clans.find((row) => normalizeTag(row.identity.clanTag) === clanTag);
  if (!clan) {
    await interaction.editReply(`That clan is not available in the Sync #${parsed.syncNumber} retrospective.`);
    return;
  }

  await interaction.editReply({
    embeds: buildSyncRetrospectiveClanDetailEmbeds(result, clan),
  });
}
