-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "checkinCopy" JSONB,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "checkinResearchMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkinTone" TEXT NOT NULL DEFAULT 'FUNNY',
ADD COLUMN     "checkinsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CheckinLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "tone" TEXT NOT NULL,
    "hasFirstStep" BOOLEAN NOT NULL DEFAULT false,
    "copySource" TEXT NOT NULL,
    "moodAtPlan" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckinLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckinLog_userId_fireAt_idx" ON "CheckinLog"("userId", "fireAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckinLog_taskId_kind_fireAt_key" ON "CheckinLog"("taskId", "kind", "fireAt");

-- AddForeignKey
ALTER TABLE "CheckinLog" ADD CONSTRAINT "CheckinLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinLog" ADD CONSTRAINT "CheckinLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
