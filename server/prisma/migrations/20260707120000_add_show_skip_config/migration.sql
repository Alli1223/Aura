-- CreateTable
CREATE TABLE "ShowSkipConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "showItemId" TEXT NOT NULL,
    "introEndMs" INTEGER,
    "creditsStartMs" INTEGER,
    "creditsFromEndMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShowSkipConfig_showItemId_fkey" FOREIGN KEY ("showItemId") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowSkipConfig_showItemId_key" ON "ShowSkipConfig"("showItemId");
