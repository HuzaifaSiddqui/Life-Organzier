ALTER TABLE "ConversationMessage" ADD COLUMN "embedding" JSONB;
CREATE INDEX "ConversationMessage_userId_role_createdAt_idx"
  ON "ConversationMessage"("userId", "role", "createdAt");
