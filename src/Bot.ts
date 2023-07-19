import { Client, ClientOptions, IntentsBitField } from "discord.js";



require('dotenv').config()

console.log("ClashCookies is starting...");

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});
client.login(process.env.TOKEN);

console.log(client);
