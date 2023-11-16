import { CommandInteraction as CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { Client as ClashClient } from 'clashofclans.js';

export const Hello: Command = {
    name: "hello",
    description: "Returns a greeting",
    run: async (client: Client, interaction: CommandInteraction) => {
    // run: async (client: Client, interaction: CommandInteraction, clashClient: ClashClient) => {
        const content = "Hello world!";

        await interaction.followUp({
            ephemeral: true,
            content
        });
    }
};