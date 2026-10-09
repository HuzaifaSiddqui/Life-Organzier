-- AlterTable
ALTER TABLE "CheckinLog" ADD COLUMN     "researchMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completedVia" TEXT;
