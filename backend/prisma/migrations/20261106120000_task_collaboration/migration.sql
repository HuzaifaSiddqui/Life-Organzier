-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "SharedTaskKind" AS ENUM ('ASSIGN', 'COLLAB');

-- CreateEnum
CREATE TYPE "SharedMemberStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "username" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "sharedTaskId" TEXT;

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedTask" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "SharedTaskKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3),
    "dueTime" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT,
    "durationMinutes" INTEGER,
    "taskType" "TaskType" NOT NULL DEFAULT 'FLEXIBLE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedTaskMember" (
    "id" TEXT NOT NULL,
    "sharedTaskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SharedMemberStatus" NOT NULL DEFAULT 'PENDING',
    "reapproval" BOOLEAN NOT NULL DEFAULT false,
    "proposedChange" JSONB,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedTaskMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollabNotice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "sharedTaskId" TEXT,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollabNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Connection_addresseeId_status_idx" ON "Connection"("addresseeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_requesterId_addresseeId_key" ON "Connection"("requesterId", "addresseeId");

-- CreateIndex
CREATE INDEX "SharedTask_ownerId_createdAt_idx" ON "SharedTask"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "SharedTaskMember_userId_status_idx" ON "SharedTaskMember"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SharedTaskMember_sharedTaskId_userId_key" ON "SharedTaskMember"("sharedTaskId", "userId");

-- CreateIndex
CREATE INDEX "CollabNotice_userId_createdAt_idx" ON "CollabNotice"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Task_sharedTaskId_idx" ON "Task"("sharedTaskId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sharedTaskId_fkey" FOREIGN KEY ("sharedTaskId") REFERENCES "SharedTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedTask" ADD CONSTRAINT "SharedTask_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedTaskMember" ADD CONSTRAINT "SharedTaskMember_sharedTaskId_fkey" FOREIGN KEY ("sharedTaskId") REFERENCES "SharedTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedTaskMember" ADD CONSTRAINT "SharedTaskMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollabNotice" ADD CONSTRAINT "CollabNotice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollabNotice" ADD CONSTRAINT "CollabNotice_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

