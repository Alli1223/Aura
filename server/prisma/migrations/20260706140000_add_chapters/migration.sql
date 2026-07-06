-- CreateTable
CREATE TABLE "Chapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaFileId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "title" TEXT,
    CONSTRAINT "Chapter_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "MediaFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Chapter_mediaFileId_idx" ON "Chapter"("mediaFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_mediaFileId_index_key" ON "Chapter"("mediaFileId", "index");
