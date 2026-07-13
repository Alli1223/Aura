-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sortName" TEXT NOT NULL,
    "overview" TEXT,
    "posterPath" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "tmdbCollectionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CollectionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CollectionItem_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Collection_tmdbCollectionId_key" ON "Collection"("tmdbCollectionId");

-- CreateIndex
CREATE INDEX "Collection_sortName_idx" ON "Collection"("sortName");

-- CreateIndex
CREATE INDEX "CollectionItem_mediaItemId_idx" ON "CollectionItem"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionItem_collectionId_mediaItemId_key" ON "CollectionItem"("collectionId", "mediaItemId");
