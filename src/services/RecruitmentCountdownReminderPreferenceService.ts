import { prisma } from "../prisma";

/** Purpose: normalize a guild-scoped Discord user id. */
function normalizeUserId(input: string): string {
  return String(input ?? "").trim();
}

/** Purpose: keep recruitment countdown reminder muting in one small guild+user state table. */
export class RecruitmentCountdownReminderPreferenceService {
  /** Purpose: read whether countdown reminders are enabled for one guild/user pair, defaulting to enabled. */
  async isEnabled(guildId: string, userId: string): Promise<boolean> {
    const guild = String(guildId ?? "").trim();
    const user = normalizeUserId(userId);
    if (!guild || !user) return true;

    const row = await prisma.recruitmentCountdownReminderPreference.findUnique({
      where: { guildId_userId: { guildId: guild, userId: user } },
      select: { remindersEnabled: true },
    });
    return row?.remindersEnabled ?? true;
  }

  /** Purpose: persist whether countdown reminders are enabled for one guild/user pair. */
  async setEnabled(input: {
    guildId: string;
    userId: string;
    enabled: boolean;
  }): Promise<void> {
    const guild = String(input.guildId ?? "").trim();
    const user = normalizeUserId(input.userId);
    if (!guild || !user) return;

    await prisma.recruitmentCountdownReminderPreference.upsert({
      where: { guildId_userId: { guildId: guild, userId: user } },
      create: {
        guildId: guild,
        userId: user,
        remindersEnabled: Boolean(input.enabled),
      },
      update: {
        remindersEnabled: Boolean(input.enabled),
      },
    });
  }
}

export const recruitmentCountdownReminderPreferenceService =
  new RecruitmentCountdownReminderPreferenceService();
