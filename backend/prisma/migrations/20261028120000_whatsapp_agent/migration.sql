-- WhatsApp Agent (WHATSAPP_AGENT=on). Additive only: two new tables and two new columns with defaults.

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "waAgentReminders" TEXT NOT NULL DEFAULT 'OFF',
ADD COLUMN     "waAgentVoice" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WhatsAppAgentConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastOffset" TEXT,
    "lastPollAt" TIMESTAMP(3),
    "chatRef" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "rateLimitedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAgentConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppProcessedUpdate" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "updateId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppProcessedUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAgentConnection_userId_key" ON "WhatsAppAgentConnection"("userId");

-- CreateIndex
CREATE INDEX "WhatsAppAgentConnection_status_idx" ON "WhatsAppAgentConnection"("status");

-- CreateIndex
CREATE INDEX "WhatsAppProcessedUpdate_processedAt_createdAt_idx" ON "WhatsAppProcessedUpdate"("processedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppProcessedUpdate_connectionId_updateId_key" ON "WhatsAppProcessedUpdate"("connectionId", "updateId");

-- AddForeignKey
ALTER TABLE "WhatsAppAgentConnection" ADD CONSTRAINT "WhatsAppAgentConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppProcessedUpdate" ADD CONSTRAINT "WhatsAppProcessedUpdate_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "WhatsAppAgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
