-- AlterTable
ALTER TABLE "User" ADD COLUMN "preferredQuality" TEXT;
ALTER TABLE "User" ADD COLUMN "preferredSubtitleLanguage" TEXT;
ALTER TABLE "User" ADD COLUMN "autoplayNextEpisode" BOOLEAN NOT NULL DEFAULT true;
