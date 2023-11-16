import { Client, ClientOptions, IntentsBitField } from "discord.js";
import interactionCreate from "./listeners/interactionCreate";
import ready from "./listeners/ready";
import { CoCService } from "./services/CoCService";
import * as ko from "knockout";

require("dotenv").config();

const discordClient = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

class ClashCookies {
  public clashClient = ko.observable();

  constructor() {
    console.log("test timing");
    
  }
}

ready(discordClient); //register with client

// interactionCreate(discordClient, CoCService); //register interactionCreate
// const cocService = new CoCService();


discordClient.login(process.env.TOKEN);

