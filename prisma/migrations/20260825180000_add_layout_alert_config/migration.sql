CREATE TYPE "LayoutAlertMode" AS ENUM ('DM', 'DEFAULT_CHANNEL', 'BOTH', 'CUSTOM_CHANNEL');

CREATE TABLE "LayoutAlertConfig" (
    "layoutId" TEXT NOT NULL,
    "mode" "LayoutAlertMode" NOT NULL,
    "customChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayoutAlertConfig_pkey" PRIMARY KEY ("layoutId"),
    CONSTRAINT "LayoutAlertConfig_layoutId_fkey"
      FOREIGN KEY ("layoutId") REFERENCES "LayoutRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LayoutAlertConfig_customChannel_check"
      CHECK (("mode" = 'CUSTOM_CHANNEL' AND "customChannelId" IS NOT NULL)
        OR ("mode" <> 'CUSTOM_CHANNEL' AND "customChannelId" IS NULL))
);
