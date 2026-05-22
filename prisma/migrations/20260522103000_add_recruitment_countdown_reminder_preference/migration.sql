CREATE TABLE "RecruitmentCountdownReminderPreference" (
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentCountdownReminderPreference_pkey" PRIMARY KEY ("guildId","userId")
);
