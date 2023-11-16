import { CommandInteraction as CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { Client as ClashClient } from 'clashofclans.js';


export const Members: Command = {
  name: "members",
  description: "lists members",
  run: async (client: Client, interaction: CommandInteraction) => {
  // run: async (client: Client, interaction: CommandInteraction, clashClient: ClashClient) => {
    
    // this.cocClient.getClan('#2QG2C08UP').then((clan) => {
      //   console.log(`${clan.name} (${clan.tag})`);
      // });
    const content = "list of members below: ...";
    await interaction.followUp({
      ephemeral: true,
      content,
    });
  },
};
