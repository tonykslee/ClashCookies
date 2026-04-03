import { prisma } from "../prisma";

/** Purpose: keep lightweight `/todo` activation state in one tiny service boundary. */
export class TodoUserUsageService {
  /** Purpose: check whether one Discord user has ever used `/todo`. */
  async hasUsedTodo(input: { discordUserId: string }): Promise<boolean> {
    const row = await prisma.todoUserUsage.findUnique({
      where: { discordUserId: String(input.discordUserId).trim() },
      select: { discordUserId: true },
    });
    return Boolean(row?.discordUserId);
  }

  /** Purpose: mark one Discord user as having used `/todo` without duplicating ownership. */
  async markUsedTodo(input: { discordUserId: string }): Promise<void> {
    const discordUserId = String(input.discordUserId).trim();
    if (!discordUserId) return;

    const now = new Date();
    await prisma.todoUserUsage.upsert({
      where: { discordUserId },
      create: {
        discordUserId,
        activatedAt: now,
        lastUsedAt: now,
      },
      update: {
        lastUsedAt: now,
      },
    });
  }
}

export const todoUserUsageService = new TodoUserUsageService();
