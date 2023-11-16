import { CommandInteraction as CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { CoCService } from '../services/CoCService';



export const GetClanName: Command = {
  name: "testname",
  description: "get clan name from tag",
  run: async (client: Client, interaction: CommandInteraction) => {
  // run: async (client: Client, interaction: CommandInteraction, clashClient: ClashClient) => {
    let content = "test";
    
    // CoCService
    // .getClan('#2QG2C08UP').then((clan) => {
    //     content = `${clan.name} (${clan.tag})`;
    //     console.log(content);
    //   });
    await interaction.followUp({
      ephemeral: true,
      content,
    });
  },
};
