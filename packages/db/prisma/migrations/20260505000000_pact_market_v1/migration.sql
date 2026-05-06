-- Pact Market v1 reset migration.
-- Devnet DB is empty; this is a clean install of the layered schema (per §5.8).

-- CreateTable
CREATE TABLE "Endpoint" (
    "slug" VARCHAR(16) NOT NULL,
    "flatPremiumLamports" BIGINT NOT NULL,
    "percentBps" INTEGER NOT NULL,
    "slaLatencyMs" INTEGER NOT NULL,
    "imputedCostLamports" BIGINT NOT NULL,
    "exposureCapPerHourLamports" BIGINT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "upstreamBase" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Endpoint_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "Agent" (
    "pubkey" VARCHAR(44) NOT NULL,
    "displayName" TEXT,
    "totalPremiumsLamports" BIGINT NOT NULL DEFAULT 0,
    "totalRefundsLamports" BIGINT NOT NULL DEFAULT 0,
    "callCount" BIGINT NOT NULL DEFAULT 0,
    "lastCallAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("pubkey")
);

-- CreateTable
CREATE TABLE "Call" (
    "callId" VARCHAR(36) NOT NULL,
    "agentPubkey" VARCHAR(44) NOT NULL,
    "endpointSlug" VARCHAR(16) NOT NULL,
    "premiumLamports" BIGINT NOT NULL,
    "refundLamports" BIGINT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "breach" BOOLEAN NOT NULL,
    "breachReason" VARCHAR(16),
    "source" VARCHAR(32),
    "ts" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "signature" VARCHAR(88) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("callId")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "signature" VARCHAR(88) NOT NULL,
    "batchSize" INTEGER NOT NULL,
    "totalPremiumsLamports" BIGINT NOT NULL,
    "totalRefundsLamports" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("signature")
);

-- CreateTable
CREATE TABLE "SettlementRecipientShare" (
    "id" TEXT NOT NULL,
    "settlementSig" VARCHAR(88) NOT NULL,
    "recipientKind" INTEGER NOT NULL,
    "recipientPubkey" VARCHAR(44) NOT NULL,
    "amountLamports" BIGINT NOT NULL,

    CONSTRAINT "SettlementRecipientShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable: per-endpoint pool state.
CREATE TABLE "PoolState" (
    "endpointSlug" VARCHAR(16) NOT NULL,
    "currentBalanceLamports" BIGINT NOT NULL,
    "totalDepositsLamports" BIGINT NOT NULL,
    "totalPremiumsLamports" BIGINT NOT NULL,
    "totalFeesPaidLamports" BIGINT NOT NULL,
    "totalRefundsLamports" BIGINT NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PoolState_pkey" PRIMARY KEY ("endpointSlug")
);

-- CreateTable
CREATE TABLE "RecipientEarnings" (
    "recipientPubkey" VARCHAR(44) NOT NULL,
    "recipientKind" INTEGER NOT NULL,
    "lifetimeEarnedLamports" BIGINT NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientEarnings_pkey" PRIMARY KEY ("recipientPubkey")
);

-- CreateTable
CREATE TABLE "DemoAllowlist" (
    "walletPubkey" VARCHAR(44) NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "DemoAllowlist_pkey" PRIMARY KEY ("walletPubkey")
);

-- CreateTable
CREATE TABLE "OperatorAllowlist" (
    "walletPubkey" VARCHAR(44) NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "OperatorAllowlist_pkey" PRIMARY KEY ("walletPubkey")
);

-- CreateIndex
CREATE INDEX "Call_agentPubkey_ts_idx" ON "Call"("agentPubkey", "ts" DESC);

-- CreateIndex
CREATE INDEX "Call_endpointSlug_ts_idx" ON "Call"("endpointSlug", "ts" DESC);

-- CreateIndex
CREATE INDEX "Call_ts_idx" ON "Call"("ts" DESC);

-- CreateIndex
CREATE INDEX "Call_breach_ts_idx" ON "Call"("breach", "ts" DESC);

-- CreateIndex
CREATE INDEX "SettlementRecipientShare_recipientPubkey_idx" ON "SettlementRecipientShare"("recipientPubkey");

-- CreateIndex
CREATE INDEX "SettlementRecipientShare_settlementSig_idx" ON "SettlementRecipientShare"("settlementSig");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_agentPubkey_fkey" FOREIGN KEY ("agentPubkey") REFERENCES "Agent"("pubkey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_endpointSlug_fkey" FOREIGN KEY ("endpointSlug") REFERENCES "Endpoint"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRecipientShare" ADD CONSTRAINT "SettlementRecipientShare_settlementSig_fkey" FOREIGN KEY ("settlementSig") REFERENCES "Settlement"("signature") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolState" ADD CONSTRAINT "PoolState_endpointSlug_fkey" FOREIGN KEY ("endpointSlug") REFERENCES "Endpoint"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;
