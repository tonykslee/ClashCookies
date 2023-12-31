import { Client } from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";
import interactionCreate from "./interactionCreate";
import { Client as ClashClient } from 'clashofclans.js';

// export default (client: Client, clashClient: ko.Observable): void => {
export default (client: Client): void => {
  client.on("ready", async () => {
    if (!client.user || !client.application) {
      return;
    }

    console.log("ClashCookies is starting...");

    let registerBotCommands : Promise<any> = client.application.commands.set(Commands).then(() => {
      console.log(Commands.length, "discord bot commands registered");
    }).catch(err => {
      console.log(err);
    });

    const clashService = new CoCService();
    let connectClashAPI = clashService.cocClient;
    // clashClient(clashService.cocClient); //assign cocClicent to observable

    Promise.allSettled([registerBotCommands, connectClashAPI]).then(() => {
      console.log(`ClashCookies is online`);
      interactionCreate(client); //register interactionCreate
    });
  });

  client.on("messageCreate", (message) => {
    console.log(message)
  })

};
