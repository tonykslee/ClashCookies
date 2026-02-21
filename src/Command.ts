import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { CoCService } from "./services/CoCService";

export interface Command {
  name: string;
  description: string;
  options?: any[];
  run: (
    client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => Promise<void>;
  autocomplete?: (
    interaction: AutocompleteInteraction
  ) => Promise<void>;
}
