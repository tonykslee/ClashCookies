-- CreateEnum
CREATE TYPE "FwaLayoutType" AS ENUM ('RISINGDAWN', 'BASIC', 'ICE');

-- CreateTable
CREATE TABLE "FwaLayouts" (
    "Townhall" INTEGER NOT NULL,
    "Type" "FwaLayoutType" NOT NULL,
    "LayoutLink" TEXT NOT NULL,
    "ImageUrl" TEXT,
    "LastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaLayouts_pkey" PRIMARY KEY ("Townhall","Type")
);

-- CreateIndex
CREATE INDEX "FwaLayouts_Type_idx" ON "FwaLayouts"("Type");
