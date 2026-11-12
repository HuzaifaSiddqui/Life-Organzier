-- Task collaboration: decline reasons, shared progress for tasks done together, invitation emails. Additive only.
ALTER TABLE "SharedTask" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SharedTask" ADD COLUMN "progressById" TEXT;
ALTER TABLE "SharedTask" ADD COLUMN "progressAt" TIMESTAMP(3);
ALTER TABLE "SharedTaskMember" ADD COLUMN "declineReason" TEXT;
ALTER TABLE "Task" ADD COLUMN "progressUpdatedBy" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "emailInvites" BOOLEAN NOT NULL DEFAULT true;
