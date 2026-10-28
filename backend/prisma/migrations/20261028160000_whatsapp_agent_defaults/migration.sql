-- WhatsApp Agent on by default: reminders on WhatsApp and the phone, voice notes transcribed.

-- AlterTable
ALTER TABLE "UserSettings" ALTER COLUMN "waAgentReminders" SET DEFAULT 'BOTH',
ALTER COLUMN "waAgentVoice" SET DEFAULT true;

-- Nobody could have chosen otherwise without connecting an agent: everyone else gets the new defaults.
UPDATE "UserSettings" s SET "waAgentReminders" = 'BOTH', "waAgentVoice" = true
WHERE NOT EXISTS (SELECT 1 FROM "WhatsAppAgentConnection" c WHERE c."userId" = s."userId");
