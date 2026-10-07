-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TaskSource" ADD VALUE 'DOCUMENT';
ALTER TYPE "TaskSource" ADD VALUE 'WHATSAPP';
ALTER TYPE "TaskSource" ADD VALUE 'ASSISTANT';

-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'APP',
ADD COLUMN     "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "state" JSONB,
ADD COLUMN     "summarizedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "summary" TEXT;

-- AlterTable
ALTER TABLE "Routine" ADD COLUMN     "locationContext" TEXT,
ADD COLUMN     "wellnessType" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "difficulty" INTEGER,
ADD COLUMN     "documentId" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "lastModifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "scheduledEnd" TIMESTAMP(3),
ADD COLUMN     "scheduledStart" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "phoneNumber" TEXT;

-- CreateTable
CREATE TABLE "TaskVersion" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "language" TEXT NOT NULL DEFAULT 'en',
    "quietStart" TEXT NOT NULL DEFAULT '22:00',
    "quietEnd" TEXT NOT NULL DEFAULT '08:00',
    "workStart" TEXT NOT NULL DEFAULT '08:00',
    "workEnd" TEXT NOT NULL DEFAULT '22:00',
    "dailyCapacityMinutes" INTEGER NOT NULL DEFAULT 480,
    "notificationFrequency" TEXT NOT NULL DEFAULT 'ADAPTIVE',
    "notificationMethod" TEXT NOT NULL DEFAULT 'SOUND_VIBRATION',
    "notificationDevices" TEXT NOT NULL DEFAULT 'ALL',
    "criticalOverridesDnd" BOOLEAN NOT NULL DEFAULT true,
    "dndUntil" TIMESTAMP(3),
    "currentContext" TEXT,
    "contexts" JSONB NOT NULL DEFAULT '["At Home", "At Work", "At University"]',
    "tier" TEXT NOT NULL DEFAULT 'FREE',
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "tutorialsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tutorialsSeen" JSONB NOT NULL DEFAULT '[]',
    "dismissedInsights" JSONB NOT NULL DEFAULT '[]',
    "ttsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ttsRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastWhatsappMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "score" INTEGER,
    "source" TEXT NOT NULL,
    "confidence" INTEGER,
    "note" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoodLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "embedding" DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "source" TEXT,
    "metadata" JSONB,
    "reinforcedCount" INTEGER NOT NULL DEFAULT 1,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPattern" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "routineOccurrenceId" TEXT,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "level" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "action" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "docType" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'eng',
    "text" TEXT NOT NULL,
    "ocrConfidence" INTEGER,
    "extracted" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskVersion_userId_createdAt_idx" ON "TaskVersion"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskVersion_taskId_version_key" ON "TaskVersion"("taskId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_name_key" ON "Category"("userId", "name");

-- CreateIndex
CREATE INDEX "MoodLog_userId_createdAt_idx" ON "MoodLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryItem_userId_kind_idx" ON "MemoryItem"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "UserPattern_userId_key_key" ON "UserPattern"("userId", "key");

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_type_createdAt_idx" ON "ActivityEvent"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ReminderLog_userId_status_fireAt_idx" ON "ReminderLog"("userId", "status", "fireAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_userId_taskId_fireAt_key" ON "ReminderLog"("userId", "taskId", "fireAt");

-- CreateIndex
CREATE INDEX "Document_userId_createdAt_idx" ON "Document"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_userId_updatedAt_idx" ON "Task"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_userId_clientId_key" ON "Task"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- AddForeignKey
ALTER TABLE "TaskVersion" ADD CONSTRAINT "TaskVersion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskVersion" ADD CONSTRAINT "TaskVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodLog" ADD CONSTRAINT "MoodLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPattern" ADD CONSTRAINT "UserPattern_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: completion timestamps and sync metadata for existing tasks.
UPDATE "Task" SET "completedAt" = "updatedAt" WHERE "status" = 'COMPLETED' AND "completedAt" IS NULL;
UPDATE "Task" SET "lastModifiedAt" = "updatedAt";

-- Backfill: default settings row for every existing user.
INSERT INTO "UserSettings" ("userId", "updatedAt")
SELECT "id", CURRENT_TIMESTAMP FROM "User"
ON CONFLICT ("userId") DO NOTHING;

-- Backfill: legacy preferences become long-term memories (re-embedded lazily by the app).
INSERT INTO "MemoryItem" ("id", "userId", "kind", "content", "importance", "embedding", "source", "createdAt", "updatedAt")
SELECT "id", "userId", 'PREFERENCE', "content", 0.7, ARRAY[]::DOUBLE PRECISION[], 'legacy_preference', "createdAt", "updatedAt"
FROM "UserPreference"
ON CONFLICT ("id") DO NOTHING;
