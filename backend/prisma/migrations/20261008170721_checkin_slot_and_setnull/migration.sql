/*
  Warnings:

  - Added the required column `slotStart` to the `CheckinLog` table without a default value. This is not possible if the table is not empty.
  - Safe here: nothing writes CheckinLog before the check-in endpoints (FR-RN-004 Phase D), so it is empty everywhere.

*/
-- DropForeignKey
ALTER TABLE "CheckinLog" DROP CONSTRAINT "CheckinLog_taskId_fkey";

-- AlterTable
ALTER TABLE "CheckinLog" ADD COLUMN     "slotStart" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "taskId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "CheckinLog" ADD CONSTRAINT "CheckinLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
