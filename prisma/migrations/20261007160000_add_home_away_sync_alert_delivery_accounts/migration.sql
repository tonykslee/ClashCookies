-- Preserve immutable account membership for each Home Away reminder delivery.
CREATE TABLE "HomeAwaySyncAlertDeliveryAccount" (
    "id" TEXT NOT NULL,
    "homeAwaySyncAlertDeliveryId" TEXT NOT NULL,
    "homeMembershipPeriodId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeAwaySyncAlertDeliveryAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HomeAwaySyncAlertDeliveryAccount_homeAwaySyncAlertDeliveryId_homeMembershipPeriodId_playerTag_key"
    ON "HomeAwaySyncAlertDeliveryAccount"("homeAwaySyncAlertDeliveryId", "homeMembershipPeriodId", "playerTag");
CREATE INDEX "HomeAwaySyncAlertDeliveryAccount_guildId_homeMembershipPeriodId_playerTag_idx"
    ON "HomeAwaySyncAlertDeliveryAccount"("guildId", "homeMembershipPeriodId", "playerTag");
CREATE INDEX "HomeAwaySyncAlertDeliveryAccount_homeMembershipPeriodId_playerTag_idx"
    ON "HomeAwaySyncAlertDeliveryAccount"("homeMembershipPeriodId", "playerTag");

ALTER TABLE "HomeAwaySyncAlertDeliveryAccount"
    ADD CONSTRAINT "HomeAwaySyncAlertDeliveryAccount_homeAwaySyncAlertDeliveryId_fkey"
    FOREIGN KEY ("homeAwaySyncAlertDeliveryId") REFERENCES "HomeAwaySyncAlertDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HomeAwaySyncAlertDeliveryAccount"
    ADD CONSTRAINT "HomeAwaySyncAlertDeliveryAccount_homeMembershipPeriodId_fkey"
    FOREIGN KEY ("homeMembershipPeriodId") REFERENCES "ClanHomeMembershipPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
