import { Command } from "./Command";
import { Hello } from "./commands/Hello";
import { Members } from "./commands/Members";
import { GetClanName } from "./commands/GetClanName";

export const Commands: Command[] = [Hello, Members, GetClanName];