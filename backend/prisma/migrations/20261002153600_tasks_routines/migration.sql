CREATE TYPE "TaskType" AS ENUM ('DEADLINE', 'FLEXIBLE', 'DURATION', 'FIXED', 'ROUTINE');

ALTER TABLE "Task"
  ADD COLUMN "parentTaskId" TEXT,
  ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "durationMinutes" INTEGER,
  ADD COLUMN "taskType" "TaskType" NOT NULL DEFAULT 'FLEXIBLE',
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Task_userId_dueDate_idx" ON "Task"("userId", "dueDate");
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey"
  FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "RoutineFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');
CREATE TYPE "RoutinePriority" AS ENUM ('MANDATORY', 'IMPORTANT', 'NORMAL');
CREATE TYPE "RoutineOccurrenceStatus" AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED', 'MISSED');

CREATE TABLE "Routine" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "frequency" "RoutineFrequency" NOT NULL,
  "daysOfWeek" JSONB,
  "dayOfMonth" INTEGER,
  "dueTime" TEXT,
  "durationMinutes" INTEGER,
  "category" TEXT,
  "priority" "RoutinePriority" NOT NULL DEFAULT 'NORMAL',
  "timeLocked" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Routine_userId_active_idx" ON "Routine"("userId", "active");
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RoutineOccurrence" (
  "id" TEXT NOT NULL,
  "routineId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "occurrenceDate" TIMESTAMP(3) NOT NULL,
  "dueTime" TEXT,
  "status" "RoutineOccurrenceStatus" NOT NULL DEFAULT 'PENDING',
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoutineOccurrence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoutineOccurrence_routineId_occurrenceDate_key" ON "RoutineOccurrence"("routineId", "occurrenceDate");
CREATE INDEX "RoutineOccurrence_userId_occurrenceDate_idx" ON "RoutineOccurrence"("userId", "occurrenceDate");
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_routineId_fkey"
  FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
