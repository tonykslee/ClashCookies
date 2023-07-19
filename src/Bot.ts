import { Client, ClientOptions, IntentsBitField } from "discord.js";
import * as dotenv from "dotenv";

console.log("ClashCookies is starting...");

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});
console.log(process.env.TOKEN);
client.login("MTEzMTMzNTc4MjAxNjIzNzc0OQ.GOXQIg.rJ1xpfO39L5dAAUL6NuMY_geQaArHBzjPcnCXQ");

console.log(client);
