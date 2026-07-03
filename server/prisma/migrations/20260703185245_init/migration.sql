-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastLoginAt" DATETIME
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Library" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LibraryPath" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "libraryId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    CONSTRAINT "LibraryPath_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LibraryAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,
    CONSTRAINT "LibraryAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LibraryAccess_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LibraryAccess_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "libraryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "year" INTEGER,
    "overview" TEXT,
    "tagline" TEXT,
    "runtimeMs" INTEGER,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "absoluteEpisodeNumber" INTEGER,
    "contentRating" TEXT,
    "communityRating" REAL,
    "tmdbId" INTEGER,
    "imdbId" TEXT,
    "anilistId" INTEGER,
    "posterPath" TEXT,
    "backdropPath" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaItem_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Genre" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "MediaFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaItemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mtimeMs" BIGINT NOT NULL,
    "container" TEXT,
    "durationMs" INTEGER,
    "bitrate" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'available',
    CONSTRAINT "MediaFile_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaStream" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaFileId" TEXT NOT NULL,
    "streamIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "codec" TEXT,
    "language" TEXT,
    "title" TEXT,
    "channels" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isForced" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "MediaStream_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "MediaFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WatchState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "watched" BOOLEAN NOT NULL DEFAULT false,
    "watchedAt" DATETIME,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WatchState_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" TEXT,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_GenreToMediaItem" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_GenreToMediaItem_A_fkey" FOREIGN KEY ("A") REFERENCES "Genre" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_GenreToMediaItem_B_fkey" FOREIGN KEY ("B") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_idx" ON "RefreshSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Library_name_key" ON "Library"("name");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryPath_libraryId_path_key" ON "LibraryPath"("libraryId", "path");

-- CreateIndex
CREATE INDEX "LibraryAccess_libraryId_idx" ON "LibraryAccess"("libraryId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryAccess_userId_libraryId_key" ON "LibraryAccess"("userId", "libraryId");

-- CreateIndex
CREATE INDEX "MediaItem_libraryId_type_idx" ON "MediaItem"("libraryId", "type");

-- CreateIndex
CREATE INDEX "MediaItem_parentId_idx" ON "MediaItem"("parentId");

-- CreateIndex
CREATE INDEX "MediaItem_title_idx" ON "MediaItem"("title");

-- CreateIndex
CREATE UNIQUE INDEX "Genre_name_key" ON "Genre"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MediaFile_path_key" ON "MediaFile"("path");

-- CreateIndex
CREATE INDEX "MediaFile_mediaItemId_idx" ON "MediaFile"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaStream_mediaFileId_streamIndex_key" ON "MediaStream"("mediaFileId", "streamIndex");

-- CreateIndex
CREATE INDEX "WatchState_mediaItemId_idx" ON "WatchState"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchState_userId_mediaItemId_key" ON "WatchState"("userId", "mediaItemId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "_GenreToMediaItem_AB_unique" ON "_GenreToMediaItem"("A", "B");

-- CreateIndex
CREATE INDEX "_GenreToMediaItem_B_index" ON "_GenreToMediaItem"("B");
