import { SettingsService } from "./SettingsService";
import { TODO_TYPES, type TodoType } from "./TodoService";

const TODO_LAST_VIEWED_TYPE_KEY_PREFIX = "todo:last-viewed-type";

/** Purpose: build one stable per-user settings key for remembered `/todo` page type. */
function buildTodoLastViewedTypeKey(discordUserId: string): string {
  return `${TODO_LAST_VIEWED_TYPE_KEY_PREFIX}:${String(discordUserId ?? "").trim()}`;
}

/** Purpose: parse stored `/todo` page type into a known enum value or null fallback. */
function parseStoredTodoType(input: string | null | undefined): TodoType | null {
  const value = String(input ?? "").trim().toUpperCase();
  if (TODO_TYPES.includes(value as TodoType)) {
    return value as TodoType;
  }
  return null;
}

export class TodoLastViewedTypeService {
  constructor(private readonly settings = new SettingsService()) {}

  /** Purpose: read one user's remembered `/todo` page type from durable settings. */
  async getLastViewedType(input: { discordUserId: string }): Promise<TodoType | null> {
    const raw = await this.settings.get(buildTodoLastViewedTypeKey(input.discordUserId));
    return parseStoredTodoType(raw);
  }

  /** Purpose: persist one user's most recently viewed `/todo` page type. */
  async setLastViewedType(input: { discordUserId: string; type: TodoType }): Promise<void> {
    await this.settings.set(
      buildTodoLastViewedTypeKey(input.discordUserId),
      String(input.type).trim().toUpperCase(),
    );
  }
}

export const todoLastViewedTypeService = new TodoLastViewedTypeService();
