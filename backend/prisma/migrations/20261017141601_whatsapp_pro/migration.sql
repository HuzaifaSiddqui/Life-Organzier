-- AlterTable
ALTER TABLE "Routine" ADD COLUMN     "location" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "remindersPlannedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WhatsappLinkCode" (
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappLinkCode_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "WhatsappInbound" (
    "messageSid" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappInbound_pkey" PRIMARY KEY ("messageSid")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappLinkCode_codeHash_key" ON "WhatsappLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "WhatsappInbound_status_createdAt_idx" ON "WhatsappInbound"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsappLinkCode" ADD CONSTRAINT "WhatsappLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No number was ever verified: everyone links again with a LINK code.
UPDATE "User" SET "phoneNumber" = NULL WHERE "phoneNumber" IS NOT NULL;

-- Rooms used to be appended to class titles as "(Room X)". Copy them into location; titles stay as they are.
UPDATE "Routine"
SET "location" = substring("title" from '\(Room ([^)]+)\)\s*$')
WHERE "location" IS NULL AND "title" ~ '\(Room [^)]+\)\s*$';
