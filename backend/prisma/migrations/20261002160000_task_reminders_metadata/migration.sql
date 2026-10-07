-- Add task metadata used by reminders, categories/tags, and location contexts.
CREATE TYPE "ReminderMode" AS ENUM ('NONE', 'SINGLE', 'MULTIPLE', 'ESCALATING', 'ADAPTIVE');

ALTER TABLE "Task"
  ADD COLUMN "tags" JSONB,
  ADD COLUMN "locationContext" TEXT,
  ADD COLUMN "reminderMinutes" INTEGER,
  ADD COLUMN "reminderMode" "ReminderMode" NOT NULL DEFAULT 'ADAPTIVE';
