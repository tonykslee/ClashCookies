import { Client } from "discord.js";
import { rosterService } from "./RosterService";
import { formatError } from "../helper/formatError";

export async function syncRosterRoleAssignments(client: Client, rosterId: string): Promise<void> {
  const targets = await rosterService.getRosterRoleSyncTargets({ rosterId }).catch((error) => {
    console.error(`[roster] role_sync_targets_failed rosterId=${rosterId} error=${formatError(error)}`);
    return null;
  });
  if (!targets || !targets.rosterRoleId || targets.discordUserIds.length <= 0) {
    return;
  }

  const guild = await client.guilds.fetch(targets.roster.guildId).catch(() => null);
  if (!guild) {
    return;
  }

  const role = await guild.roles.fetch(targets.rosterRoleId).catch(() => null);
  if (!role) {
    return;
  }

  for (const discordUserId of targets.discordUserIds) {
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member || member.roles.cache.has(role.id)) {
      continue;
    }

    await member.roles.add(role.id).catch((error) => {
      console.error(
        `[roster] role_assign_failed rosterId=${rosterId} guildId=${guild.id} userId=${discordUserId} roleId=${role.id} error=${formatError(error)}`,
      );
    });
  }
}
