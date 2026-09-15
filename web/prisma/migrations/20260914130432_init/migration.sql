-- CreateEnum
CREATE TYPE "GameFormat" AS ENUM ('single', 'match');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('created', 'active', 'finished', 'abandoned');

-- CreateEnum
CREATE TYPE "BotLevel" AS ENUM ('beginner', 'intermediate', 'club');

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "token" TEXT,
    "format" "GameFormat" NOT NULL,
    "matchLength" INTEGER NOT NULL,
    "clockConfig" JSONB,
    "botLevel" "BotLevel",
    "seed" BIGINT NOT NULL,
    "status" "GameStatus" NOT NULL,
    "result" JSONB,
    "moveLog" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameSeat" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "userId" TEXT,
    "guestName" TEXT,
    "seatSecretHash" TEXT,

    CONSTRAINT "GameSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Game_token_key" ON "Game"("token");

-- CreateIndex
CREATE INDEX "Game_status_createdAt_idx" ON "Game"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GameSeat_userId_idx" ON "GameSeat"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GameSeat_gameId_seat_key" ON "GameSeat"("gameId", "seat");

-- AddForeignKey
ALTER TABLE "GameSeat" ADD CONSTRAINT "GameSeat_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
