import { CommandInteraction as CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import { Client as ClashClient } from 'clashofclans.js';



export const GetClanName: Command = {
  name: "clan-name",
  description: "get clan name from tag",
  run: async (client: Client, interaction: CommandInteraction, clashClient: ko.Observable) => {
  // run: async (client: Client, interaction: CommandInteraction, clashClient: ClashClient) => {
    let content;
    let cocService = new CoCService();
    cocService.login().then(() => {
      (cocService.cocClient() as ClashClient).getClan('#2QG2C08UP').then((clan) => {
          content = `${clan.name} (${clan.tag})`;
          console.log(content);
        });
    });
    await interaction.followUp({
      ephemeral: true,
      content,
    });
  },
};
