-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "contentHash" TEXT;

-- CreateIndex
CREATE INDEX "Document_userId_contentHash_idx" ON "Document"("userId", "contentHash");
