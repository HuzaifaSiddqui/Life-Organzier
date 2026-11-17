-- Profile photo chosen by the user (upload or remove): sign-in stops copying the Google photo.
ALTER TABLE "User" ADD COLUMN "photoChosen" BOOLEAN NOT NULL DEFAULT false;

-- Document previews: the original file and a thumbnail are kept in STORAGE_DIR.
ALTER TABLE "Document" ADD COLUMN "fileStored" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN "hasThumbnail" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN "pageCount" INTEGER;
