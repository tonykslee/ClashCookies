import { Client, ClientOptions, IntentsBitField } from "discord.js";
import interactionCreate from "./listeners/interactionCreate";
import ready from "./listeners/ready";

require("dotenv").config();

console.log("ClashCookies is starting...");

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

ready(client); //register with client
interactionCreate(client); //register interactionCreate

client.login(process.env.TOKEN);

