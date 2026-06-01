import { ButtonInteraction, ButtonStyle, ComponentType } from "discord.js";

const ROSTER_MUTATION_APPLYING_LABEL = "Applying changes...";

type RosterApplyingButtonComponent = {
  type?: number;
  custom_id?: string | null;
  customId?: string | null;
  label?: string | null;
  style?: number | null;
  disabled?: boolean | null;
  emoji?: unknown;
};

type RosterApplyingSelectComponent = {
  type?: number;
  custom_id?: string | null;
  customId?: string | null;
  placeholder?: string | null;
  min_values?: number | null;
  max_values?: number | null;
  disabled?: boolean | null;
  options?: unknown[];
};

type RosterApplyingRow =
  | {
      toJSON?: () => { components?: Array<RosterApplyingButtonComponent | RosterApplyingSelectComponent>; type?: number };
    }
  | { components?: Array<RosterApplyingButtonComponent | RosterApplyingSelectComponent>; type?: number };

export function buildRosterMutationApplyingComponents(
  rows: ReadonlyArray<RosterApplyingRow>,
  confirmCustomId: string,
): Array<{ type?: number; components: Array<RosterApplyingButtonComponent | RosterApplyingSelectComponent> }> {
  return rows.map((row) => {
    const rawRow = typeof (row as { toJSON?: () => unknown }).toJSON === "function" ? (row as { toJSON: () => any }).toJSON() : row;
    const clonedComponents = (rawRow.components ?? []).map((component: RosterApplyingButtonComponent | RosterApplyingSelectComponent) => {
      const buttonComponent = component as RosterApplyingButtonComponent;
      const selectComponent = component as RosterApplyingSelectComponent;
      const customId = String(component.custom_id ?? component.customId ?? "");
      if (component.type === ComponentType.Button) {
        return {
          ...component,
          disabled: true,
          label: customId === confirmCustomId ? ROSTER_MUTATION_APPLYING_LABEL : buttonComponent.label ?? null,
          style: customId === confirmCustomId ? ButtonStyle.Secondary : buttonComponent.style ?? null,
        };
      }
      if (component.type === ComponentType.StringSelect) {
        return {
          ...component,
          disabled: true,
        };
      }
      return {
        ...selectComponent,
        disabled: true,
      };
    });
    return {
      ...(rawRow ?? {}),
      components: clonedComponents,
    };
  });
}

export async function showRosterMutationApplyingState(interaction: ButtonInteraction): Promise<void> {
  const components = buildRosterMutationApplyingComponents((interaction.message?.components ?? []) as any, interaction.customId);
  try {
    await interaction.update({
      components: components as any,
    });
  } catch {
    await interaction.deferUpdate().catch(() => undefined);
    await interaction.editReply({
      components: components as any,
    }).catch(() => undefined);
  }
}
