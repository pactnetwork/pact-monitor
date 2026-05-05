# Pact Network MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete monitoring SDK, data aggregation backend, and public reliability scorecard for AI agent API payments on Solana.

**Architecture:** Monorepo with 3 packages under `packages/`. Backend (Fastify + PostgreSQL) is the foundation — SDK sends monitoring data to it, Scorecard reads from it. Same-origin deployment: Caddy routes `/api/*` to backend, everything else to scorecard static files. Insurance rate computed server-side.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Vite, React, Tailwind CSS, Recharts, Docker, Caddy

**Spec:** `docs/superpowers/specs/2026-04-07-pact-network-mvp-design.md`

---

## File Map

### Root
| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Create | Workspace root, workspaces: ["packages/*"] |
| `tsconfig.base.json` | Create | Shared TS config: strict, ES2022, moduleResolution bundler |
| `.gitignore` | Create | node_modules, dist, .env, *.db, data/ |
| `.env.example` | Create | DATABASE_URL, API_KEY template |

### packages/backend/
| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Create | @pact-network/backend, Fastify + pg dependencies |
| `tsconfig.json` | Create | Extends root, outDir: dist |
| `src/index.ts` | Create | Server bootstrap, register routes |
| `src/db.ts` | Create | PostgreSQL pool, query helper, schema init |
| `src/schema.sql` | Create | providers, call_records, api_keys tables |
| `src/routes/health.ts` | Create | GET /health |
| `src/routes/records.ts` | Create | POST /api/v1/records (batch ingest) |
| `src/routes/providers.ts` | Create | GET providers list, detail, timeseries |
| `src/middleware/auth.ts` | Create | API key validation |
| `src/utils/insurance.ts` | Create | Rate formula + tier classification |
| `src/scripts/generate-key.ts` | Create | CLI to create API keys |
| `src/scripts/seed.ts` | Create | Generate 10K+ realistic records |
| `Dockerfile` | Create | Node.js production image |

### packages/sdk/
| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Create | @q3labs/pact-monitor, zero runtime deps |
| `tsconfig.json` | Create | Extends root, outDir: dist, declaration: true |
| `src/index.ts` | Create | Barrel export: pactMonitor(), types |
| `src/types.ts` | Create | CallRecord, PactConfig, Classification, PaymentData |
| `src/classifier.ts` | Create | Classify: success/timeout/error/schema_mismatch |
| `src/payment-extractor.ts` | Create | Detect x402/MPP headers, decode, extract |
| `src/storage.ts` | Create | JSON lines: append, read, stats, mark synced |
| `src/wrapper.ts` | Create | Fetch wrapper, orchestrates full flow |
| `src/sync.ts` | Create | Batch POST to backend on interval |

### packages/scorecard/
| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Create | @pact-network/scorecard, Vite + React deps |
| `tsconfig.json` | Create | Extends root, JSX react-jsx |
| `vite.config.ts` | Create | Dev proxy /api → backend, build config |
| `index.html` | Create | SPA entry, font links |
| `tailwind.config.ts` | Create | Design system tokens |
| `postcss.config.js` | Create | Tailwind + autoprefixer |
| `src/main.tsx` | Create | React root mount |
| `src/App.tsx` | Create | React Router: / and /provider/:id |
| `src/styles/global.css` | Create | Tailwind directives + base theme |
| `src/api/client.ts` | Create | Typed fetch wrapper for backend API |
| `src/hooks/useProviders.ts` | Create | Data fetching + 30s auto-refresh |
| `src/components/ProviderTable.tsx` | Create | Rankings table |
| `src/components/ProviderDetail.tsx` | Create | Detail page |
| `src/components/Charts/FailureTimeline.tsx` | Create | Line chart, failure over time |
| `src/components/Charts/FailureBreakdown.tsx` | Create | Bar chart, failure types |

### deploy/
| File | Action | Responsibility |
|------|--------|---------------|
| `docker-compose.yml` | Create | postgres + backend + caddy |
| `Caddyfile` | Create | Same-origin routing |

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `packages/backend/package.json`, `packages/backend/tsconfig.json`
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`
- Create: `packages/scorecard/package.json`, `packages/scorecard/tsconfig.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "pact-network",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev:backend": "npm run dev -w packages/backend",
    "dev:scorecard": "npm run dev -w packages/scorecard",
    "build:sdk": "npm run build -w packages/sdk",
    "build": "npm run build -w packages/sdk && npm run build -w packages/backend && npm run build -w packages/scorecard"
  }
}
```

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
.env
*.db
*.sqlite
data/
.superpowers/
.worktrees/
```

- [ ] **Step 4: Create .env.example**

```env
DATABASE_URL=postgresql://pact:pact@localhost:5432/pact
API_KEY=pact_dev_key_change_me
PORT=3000
```

- [ ] **Step 5: Create packages/backend/package.json**

```json
{
  "name": "@pact-network/backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "seed": "tsx src/scripts/seed.ts",
    "generate-key": "tsx src/scripts/generate-key.ts"
  },
  "dependencies": {
    "fastify": "^5.3.3",
    "pg": "^8.16.0",
    "dotenv": "^16.5.0"
  },
  "devDependencies": {
    "@types/pg": "^8.15.4",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 6: Create packages/backend/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 7: Create packages/sdk/package.json**

```json
{
  "name": "@q3labs/pact-monitor",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "node --test dist/**/*.test.js"
  },
  "devDependencies": {
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 8: Create packages/sdk/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 9: Create packages/scorecard/package.json**

```json
{
  "name": "@pact-network/scorecard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.5.0",
    "recharts": "^2.15.3"
  },
  "devDependencies": {
    "@types/react": "^19.1.2",
    "@types/react-dom": "^19.1.2",
    "@vitejs/plugin-react": "^4.4.1",
    "autoprefixer": "^10.4.21",
    "postcss": "^8.5.3",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.8.3",
    "vite": "^6.3.2"
  }
}
```

- [ ] **Step 10: Create packages/scorecard/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 11: Install dependencies**

Run from project root:
```bash
npm install
```

Expected: All three package node_modules installed, workspace symlinks created.

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.base.json .gitignore .env.example packages/backend/package.json packages/backend/tsconfig.json packages/sdk/package.json packages/sdk/tsconfig.json packages/scorecard/package.json packages/scorecard/tsconfig.json package-lock.json
git commit -m "init: monorepo scaffolding with backend, sdk, scorecard packages"
```

---

## Task 2: Backend — Database Schema & Connection

**Files:**
- Create: `packages/backend/src/schema.sql`
- Create: `packages/backend/src/db.ts`

**Prerequisite:** A running PostgreSQL instance. For local dev, use Docker:
```bash
docker run -d --name pact-pg -e POSTGRES_USER=pact -e POSTGRES_PASSWORD=pact -e POSTGRES_DB=pact -p 5432:5432 postgres:16-alpine
```

- [ ] **Step 1: Create schema.sql**

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Unknown',
  base_url TEXT NOT NULL UNIQUE,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  endpoint TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('success', 'timeout', 'error', 'schema_mismatch')),
  payment_protocol TEXT CHECK (payment_protocol IN ('x402', 'mpp') OR payment_protocol IS NULL),
  payment_amount BIGINT,
  payment_asset TEXT,
  payment_network TEXT,
  payer_address TEXT,
  recipient_address TEXT,
  tx_hash TEXT,
  settlement_success BOOLEAN,
  agent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_records_provider_id ON call_records(provider_id);
CREATE INDEX IF NOT EXISTS idx_call_records_timestamp ON call_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_call_records_classification ON call_records(classification);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Create db.ts**

```typescript
import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5432/pact",
});

export async function initDb(): Promise<void> {
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema);
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getOne<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await pool.query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function getMany<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export { pool };
```

- [ ] **Step 3: Verify schema applies cleanly**

Create a temporary test script:
```bash
cd packages/backend && npx tsx -e "
import { initDb, checkConnection, pool } from './src/db.ts';
import 'dotenv/config';
await initDb();
console.log('Schema applied:', await checkConnection());
await pool.end();
"
```

Expected: `Schema applied: true`

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/schema.sql packages/backend/src/db.ts
git commit -m "feat(backend): add PostgreSQL schema and connection layer"
```

---

## Task 3: Backend — Insurance Rate Utility

**Files:**
- Create: `packages/backend/src/utils/insurance.ts`

- [ ] **Step 1: Create insurance.ts**

```typescript
export type Tier = "RELIABLE" | "ELEVATED" | "HIGH_RISK";

export function computeInsuranceRate(failureRate: number): number {
  return Math.max(0.001, failureRate * 1.5 + 0.001);
}

export function computeTier(insuranceRate: number): Tier {
  if (insuranceRate < 0.01) return "RELIABLE";
  if (insuranceRate <= 0.05) return "ELEVATED";
  return "HIGH_RISK";
}
```

- [ ] **Step 2: Verify with inline test**

```bash
cd packages/backend && npx tsx -e "
import { computeInsuranceRate, computeTier } from './src/utils/insurance.ts';

const tests = [
  { failure: 0.001, expectedRate: 0.0025, expectedTier: 'RELIABLE' },
  { failure: 0.003, expectedRate: 0.0055, expectedTier: 'RELIABLE' },
  { failure: 0.015, expectedRate: 0.0235, expectedTier: 'ELEVATED' },
  { failure: 0.02,  expectedRate: 0.031,  expectedTier: 'ELEVATED' },
  { failure: 0.03,  expectedRate: 0.046,  expectedTier: 'ELEVATED' },
  { failure: 0.05,  expectedRate: 0.076,  expectedTier: 'HIGH_RISK' },
];

for (const t of tests) {
  const rate = computeInsuranceRate(t.failure);
  const tier = computeTier(rate);
  const rateOk = Math.abs(rate - t.expectedRate) < 0.0001;
  const tierOk = tier === t.expectedTier;
  console.log(rateOk && tierOk ? 'PASS' : 'FAIL',
    'failure:', t.failure, 'rate:', rate.toFixed(4), 'tier:', tier);
}
"
```

Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/utils/insurance.ts
git commit -m "feat(backend): add insurance rate formula and tier classification"
```

---

## Task 4: Backend — API Key Auth

**Files:**
- Create: `packages/backend/src/middleware/auth.ts`
- Create: `packages/backend/src/scripts/generate-key.ts`

- [ ] **Step 1: Create auth.ts**

```typescript
import { createHash } from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getOne } from "../db.js";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing API key" });
    return;
  }

  const key = header.slice(7);
  const hash = hashKey(key);

  const row = await getOne<{ id: string; label: string }>(
    "SELECT id, label FROM api_keys WHERE key_hash = $1",
    [hash],
  );

  if (!row) {
    reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  (request as FastifyRequest & { agentId: string }).agentId = row.label;
}

export { hashKey };
```

- [ ] **Step 2: Create generate-key.ts**

```typescript
import "dotenv/config";
import { randomBytes } from "crypto";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";

const label = process.argv[2] || "default";
const key = `pact_${randomBytes(24).toString("hex")}`;
const hash = hashKey(key);

await initDb();
await query("INSERT INTO api_keys (key_hash, label) VALUES ($1, $2)", [hash, label]);
await pool.end();

console.log(`API key generated for "${label}":`);
console.log(key);
console.log("\nStore this key securely — it cannot be retrieved later.");
```

- [ ] **Step 3: Test key generation**

```bash
cd packages/backend && npx tsx src/scripts/generate-key.ts test-agent
```

Expected: Prints a key starting with `pact_`. Key is stored hashed in the database.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/middleware/auth.ts packages/backend/src/scripts/generate-key.ts
git commit -m "feat(backend): add API key auth middleware and key generation script"
```

---

## Task 5: Backend — Records Endpoint (Batch Ingest)

**Files:**
- Create: `packages/backend/src/routes/records.ts`

- [ ] **Step 1: Create records.ts**

```typescript
import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../middleware/auth.js";
import { query, getOne } from "../db.js";

interface RecordInput {
  hostname: string;
  endpoint: string;
  timestamp: string;
  status_code: number;
  latency_ms: number;
  classification: "success" | "timeout" | "error" | "schema_mismatch";
  payment_protocol?: "x402" | "mpp" | null;
  payment_amount?: number | null;
  payment_asset?: string | null;
  payment_network?: string | null;
  payer_address?: string | null;
  recipient_address?: string | null;
  tx_hash?: string | null;
  settlement_success?: boolean | null;
}

interface RecordsBody {
  records: RecordInput[];
}

async function findOrCreateProvider(hostname: string): Promise<string> {
  const existing = await getOne<{ id: string }>(
    "SELECT id FROM providers WHERE base_url = $1",
    [hostname],
  );
  if (existing) return existing.id;

  const created = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  return created!.id;
}

export async function recordsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RecordsBody }>(
    "/api/v1/records",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { records } = request.body;

      if (!records || !Array.isArray(records) || records.length === 0) {
        return reply.code(400).send({ error: "records array is required" });
      }

      const agentId = (request as FastifyRequest & { agentId: string }).agentId;
      const providerIds = new Set<string>();
      let accepted = 0;

      for (const rec of records) {
        const providerId = await findOrCreateProvider(rec.hostname);
        providerIds.add(providerId);

        await query(
          `INSERT INTO call_records (
            provider_id, endpoint, timestamp, status_code, latency_ms,
            classification, payment_protocol, payment_amount, payment_asset,
            payment_network, payer_address, recipient_address, tx_hash,
            settlement_success, agent_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            providerId, rec.endpoint, rec.timestamp, rec.status_code,
            rec.latency_ms, rec.classification, rec.payment_protocol ?? null,
            rec.payment_amount ?? null, rec.payment_asset ?? null,
            rec.payment_network ?? null, rec.payer_address ?? null,
            rec.recipient_address ?? null, rec.tx_hash ?? null,
            rec.settlement_success ?? null, agentId,
          ],
        );
        accepted++;
      }

      // Update provider wallet_address from payment data if available
      for (const rec of records) {
        if (rec.recipient_address) {
          await query(
            "UPDATE providers SET wallet_address = $1 WHERE base_url = $2 AND wallet_address IS NULL",
            [rec.recipient_address, rec.hostname],
          );
        }
      }

      return { accepted, provider_ids: [...providerIds] };
    },
  );
}

type FastifyRequest = import("fastify").FastifyRequest;
```

- [ ] **Step 2: Commit**

```bash
git add packages/backend/src/routes/records.ts
git commit -m "feat(backend): add POST /api/v1/records batch ingest endpoint"
```

---

## Task 6: Backend — Providers Endpoints (List, Detail, Timeseries)

**Files:**
- Create: `packages/backend/src/routes/providers.ts`

- [ ] **Step 1: Create providers.ts**

```typescript
import type { FastifyInstance } from "fastify";
import { getMany, getOne } from "../db.js";
import { computeInsuranceRate, computeTier } from "../utils/insurance.js";

interface ProviderRow {
  id: string;
  name: string;
  category: string;
  base_url: string;
  wallet_address: string | null;
  total_calls: string;
  failure_count: string;
  avg_latency_ms: string;
  total_payment_amount: string | null;
  lost_payment_amount: string | null;
}

export async function providersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/providers — ranked list
  app.get("/api/v1/providers", async () => {
    const rows = await getMany<ProviderRow>(`
      SELECT
        p.id, p.name, p.category, p.base_url, p.wallet_address,
        COUNT(cr.id)::text AS total_calls,
        COUNT(cr.id) FILTER (WHERE cr.classification != 'success')::text AS failure_count,
        COALESCE(AVG(cr.latency_ms), 0)::text AS avg_latency_ms,
        SUM(cr.payment_amount)::text AS total_payment_amount,
        SUM(cr.payment_amount) FILTER (WHERE cr.classification != 'success')::text AS lost_payment_amount
      FROM providers p
      LEFT JOIN call_records cr ON cr.provider_id = p.id
      GROUP BY p.id
      HAVING COUNT(cr.id) > 0
      ORDER BY COUNT(cr.id) FILTER (WHERE cr.classification != 'success')::float / NULLIF(COUNT(cr.id), 0) ASC
    `);

    return rows.map((r) => {
      const totalCalls = parseInt(r.total_calls, 10);
      const failures = parseInt(r.failure_count, 10);
      const failureRate = totalCalls > 0 ? failures / totalCalls : 0;
      const insuranceRate = computeInsuranceRate(failureRate);

      return {
        id: r.id,
        name: r.name,
        category: r.category,
        total_calls: totalCalls,
        failure_rate: parseFloat(failureRate.toFixed(6)),
        avg_latency_ms: Math.round(parseFloat(r.avg_latency_ms)),
        uptime: parseFloat((1 - failureRate).toFixed(6)),
        insurance_rate: parseFloat(insuranceRate.toFixed(6)),
        tier: computeTier(insuranceRate),
        total_payment_amount: r.total_payment_amount ? parseInt(r.total_payment_amount, 10) : 0,
        lost_payment_amount: r.lost_payment_amount ? parseInt(r.lost_payment_amount, 10) : 0,
      };
    });
  });

  // GET /api/v1/providers/:id — detailed stats
  app.get<{ Params: { id: string } }>("/api/v1/providers/:id", async (request, reply) => {
    const { id } = request.params;

    const provider = await getOne<{ id: string; name: string; category: string; base_url: string; wallet_address: string | null }>(
      "SELECT id, name, category, base_url, wallet_address FROM providers WHERE id = $1",
      [id],
    );

    if (!provider) {
      return reply.code(404).send({ error: "Provider not found" });
    }

    const stats = await getOne<{
      total_calls: string;
      failure_count: string;
      avg_latency_ms: string;
      p50_latency_ms: string;
      p95_latency_ms: string;
      p99_latency_ms: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_calls,
        COUNT(*) FILTER (WHERE classification != 'success')::text AS failure_count,
        COALESCE(AVG(latency_ms), 0)::text AS avg_latency_ms,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p50_latency_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p95_latency_ms,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p99_latency_ms
      FROM call_records WHERE provider_id = $1
    `, [id]);

    const failureBreakdown = await getMany<{ classification: string; count: string }>(`
      SELECT classification, COUNT(*)::text AS count
      FROM call_records
      WHERE provider_id = $1 AND classification != 'success'
      GROUP BY classification
    `, [id]);

    const topEndpoints = await getMany<{ endpoint: string; calls: string; failure_rate: string }>(`
      SELECT
        endpoint,
        COUNT(*)::text AS calls,
        (COUNT(*) FILTER (WHERE classification != 'success')::float / NULLIF(COUNT(*), 0))::text AS failure_rate
      FROM call_records
      WHERE provider_id = $1
      GROUP BY endpoint
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `, [id]);

    const paymentBreakdown = await getMany<{
      payment_protocol: string | null;
      calls: string;
      total_amount: string | null;
      lost_amount: string | null;
    }>(`
      SELECT
        COALESCE(payment_protocol, 'free') AS payment_protocol,
        COUNT(*)::text AS calls,
        SUM(payment_amount)::text AS total_amount,
        SUM(payment_amount) FILTER (WHERE classification != 'success')::text AS lost_amount
      FROM call_records
      WHERE provider_id = $1
      GROUP BY payment_protocol
    `, [id]);

    const totalCalls = parseInt(stats!.total_calls, 10);
    const failures = parseInt(stats!.failure_count, 10);
    const failureRate = totalCalls > 0 ? failures / totalCalls : 0;
    const insuranceRate = computeInsuranceRate(failureRate);

    return {
      id: provider.id,
      name: provider.name,
      category: provider.category,
      total_calls: totalCalls,
      failure_rate: parseFloat(failureRate.toFixed(6)),
      avg_latency_ms: Math.round(parseFloat(stats!.avg_latency_ms)),
      p50_latency_ms: Math.round(parseFloat(stats!.p50_latency_ms)),
      p95_latency_ms: Math.round(parseFloat(stats!.p95_latency_ms)),
      p99_latency_ms: Math.round(parseFloat(stats!.p99_latency_ms)),
      uptime: parseFloat((1 - failureRate).toFixed(6)),
      insurance_rate: parseFloat(insuranceRate.toFixed(6)),
      tier: computeTier(insuranceRate),
      failure_breakdown: Object.fromEntries(
        failureBreakdown.map((r) => [r.classification, parseInt(r.count, 10)]),
      ),
      top_endpoints: topEndpoints.map((r) => ({
        endpoint: r.endpoint,
        calls: parseInt(r.calls, 10),
        failure_rate: parseFloat(parseFloat(r.failure_rate).toFixed(6)),
      })),
      payment_breakdown: Object.fromEntries(
        paymentBreakdown.map((r) => [
          r.payment_protocol,
          {
            calls: parseInt(r.calls, 10),
            total_amount: r.total_amount ? parseInt(r.total_amount, 10) : 0,
            lost_amount: r.lost_amount ? parseInt(r.lost_amount, 10) : 0,
          },
        ]),
      ),
    };
  });

  // GET /api/v1/providers/:id/timeseries
  app.get<{
    Params: { id: string };
    Querystring: { granularity?: string; days?: string };
  }>("/api/v1/providers/:id/timeseries", async (request, reply) => {
    const { id } = request.params;
    const granularity = request.query.granularity === "daily" ? "day" : "hour";
    const days = parseInt(request.query.days || "7", 10);

    const provider = await getOne<{ id: string }>(
      "SELECT id FROM providers WHERE id = $1",
      [id],
    );
    if (!provider) {
      return reply.code(404).send({ error: "Provider not found" });
    }

    const rows = await getMany<{
      bucket: string;
      calls: string;
      failures: string;
    }>(`
      SELECT
        date_trunc($1, timestamp) AS bucket,
        COUNT(*)::text AS calls,
        COUNT(*) FILTER (WHERE classification != 'success')::text AS failures
      FROM call_records
      WHERE provider_id = $2 AND timestamp > NOW() - ($3 || ' days')::interval
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [granularity, id, days.toString()]);

    return {
      provider_id: id,
      granularity: request.query.granularity === "daily" ? "daily" : "hourly",
      data: rows.map((r) => {
        const calls = parseInt(r.calls, 10);
        const failures = parseInt(r.failures, 10);
        return {
          bucket: r.bucket,
          calls,
          failures,
          failure_rate: calls > 0 ? parseFloat((failures / calls).toFixed(6)) : 0,
        };
      }),
    };
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/backend/src/routes/providers.ts
git commit -m "feat(backend): add GET providers list, detail, and timeseries endpoints"
```

---

## Task 7: Backend — Health Endpoint & Server Bootstrap

**Files:**
- Create: `packages/backend/src/routes/health.ts`
- Create: `packages/backend/src/index.ts`

- [ ] **Step 1: Create health.ts**

```typescript
import type { FastifyInstance } from "fastify";
import { checkConnection } from "../db.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const dbOk = await checkConnection();
    return { status: dbOk ? "ok" : "degraded", db: dbOk ? "connected" : "disconnected" };
  });
}
```

- [ ] **Step 2: Create index.ts (server bootstrap)**

```typescript
import "dotenv/config";
import Fastify from "fastify";
import { initDb } from "./db.js";
import { healthRoutes } from "./routes/health.js";
import { recordsRoutes } from "./routes/records.js";
import { providersRoutes } from "./routes/providers.js";

const app = Fastify({ logger: true });

await app.register(healthRoutes);
await app.register(recordsRoutes);
await app.register(providersRoutes);

const port = parseInt(process.env.PORT || "3000", 10);

try {
  await initDb();
  app.log.info("Database schema initialized");
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Server running on port ${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

- [ ] **Step 3: Start the server**

```bash
cd packages/backend && npx tsx src/index.ts
```

Expected: Server starts on port 3000, "Database schema initialized" logged.

- [ ] **Step 4: Test health endpoint**

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok","db":"connected"}`

- [ ] **Step 5: Test full API flow**

Generate a key, then POST records:
```bash
# Generate key (capture output)
cd packages/backend && npx tsx src/scripts/generate-key.ts test-agent

# POST records (replace YOUR_KEY with the generated key)
curl -X POST http://localhost:3000/api/v1/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "records": [{
      "hostname": "api.helius.xyz",
      "endpoint": "/v0/transactions",
      "timestamp": "2026-04-07T10:30:00Z",
      "status_code": 200,
      "latency_ms": 145,
      "classification": "success",
      "payment_protocol": "x402",
      "payment_amount": 1000000
    }]
  }'

# GET providers
curl http://localhost:3000/api/v1/providers
```

Expected: POST returns `{"accepted":1,"provider_ids":["..."]}`. GET returns array with one provider.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/health.ts packages/backend/src/index.ts
git commit -m "feat(backend): add health endpoint and server bootstrap — backend complete"
```

---

## Task 8: SDK — Types & Classifier

**Files:**
- Create: `packages/sdk/src/types.ts`
- Create: `packages/sdk/src/classifier.ts`

- [ ] **Step 1: Create types.ts**

```typescript
export type Classification = "success" | "timeout" | "error" | "schema_mismatch";

export interface PaymentData {
  protocol: "x402" | "mpp";
  amount: number;
  asset: string;
  network: string;
  payerAddress: string;
  recipientAddress: string;
  txHash: string;
  settlementSuccess: boolean;
}

export interface CallRecord {
  hostname: string;
  endpoint: string;
  timestamp: string;
  statusCode: number;
  latencyMs: number;
  classification: Classification;
  payment: PaymentData | null;
  synced: boolean;
}

export interface PactConfig {
  apiKey?: string;
  backendUrl?: string;
  syncEnabled?: boolean;
  syncIntervalMs?: number;
  syncBatchSize?: number;
  latencyThresholdMs?: number;
  storagePath?: string;
}

export interface ExpectedSchema {
  type: string;
  required?: string[];
}

export interface FetchOptions extends RequestInit {
  // standard fetch options
}

export interface PactFetchOptions {
  expectedSchema?: ExpectedSchema;
  usdcAmount?: number;
}
```

- [ ] **Step 2: Create classifier.ts**

```typescript
import type { Classification, ExpectedSchema } from "./types.js";

export function classify(
  statusCode: number,
  latencyMs: number,
  latencyThresholdMs: number,
  responseBody: unknown,
  expectedSchema?: ExpectedSchema,
  networkError?: boolean,
): Classification {
  if (networkError || statusCode === 0) {
    return "error";
  }

  if (statusCode < 200 || statusCode >= 300) {
    return "error";
  }

  if (latencyMs > latencyThresholdMs) {
    return "timeout";
  }

  if (expectedSchema && responseBody !== undefined) {
    if (!matchesSchema(responseBody, expectedSchema)) {
      return "schema_mismatch";
    }
  }

  return "success";
}

function matchesSchema(body: unknown, schema: ExpectedSchema): boolean {
  if (schema.type === "object" && (typeof body !== "object" || body === null)) {
    return false;
  }
  if (schema.type === "array" && !Array.isArray(body)) {
    return false;
  }
  if (schema.required && typeof body === "object" && body !== null) {
    for (const key of schema.required) {
      if (!(key in body)) {
        return false;
      }
    }
  }
  return true;
}
```

- [ ] **Step 3: Verify classifier**

```bash
cd packages/sdk && npx tsx -e "
import { classify } from './src/classifier.ts';

const tests = [
  { args: [200, 100, 5000, {}, undefined, false], expected: 'success' },
  { args: [500, 100, 5000, {}, undefined, false], expected: 'error' },
  { args: [0, 0, 5000, {}, undefined, true], expected: 'error' },
  { args: [200, 6000, 5000, {}, undefined, false], expected: 'timeout' },
  { args: [200, 100, 5000, {}, { type: 'object', required: ['data'] }, false], expected: 'schema_mismatch' },
  { args: [200, 100, 5000, { data: 1 }, { type: 'object', required: ['data'] }, false], expected: 'success' },
];

for (const t of tests) {
  const result = classify(...t.args as Parameters<typeof classify>);
  console.log(result === t.expected ? 'PASS' : 'FAIL', result, '===', t.expected);
}
"
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/classifier.ts
git commit -m "feat(sdk): add types and failure classifier"
```

---

## Task 9: SDK — Payment Extractor

**Files:**
- Create: `packages/sdk/src/payment-extractor.ts`

- [ ] **Step 1: Create payment-extractor.ts**

```typescript
import type { PaymentData } from "./types.js";

export function extractPaymentData(headers: Headers): PaymentData | null {
  try {
    const x402Data = extractX402(headers);
    if (x402Data) return x402Data;

    const mppData = extractMpp(headers);
    if (mppData) return mppData;

    return null;
  } catch {
    return null;
  }
}

function extractX402(headers: Headers): PaymentData | null {
  const raw = headers.get("PAYMENT-RESPONSE") || headers.get("payment-response");
  if (!raw) return null;

  const decoded = JSON.parse(atob(raw));

  return {
    protocol: "x402",
    amount: 0, // amount comes from PAYMENT-REQUIRED on the 402 response, not the final response
    asset: "",
    network: decoded.network || "",
    payerAddress: decoded.payer || "",
    recipientAddress: "",
    txHash: decoded.transaction || "",
    settlementSuccess: decoded.success ?? true,
  };
}

function extractMpp(headers: Headers): PaymentData | null {
  const raw = headers.get("Payment-Receipt") || headers.get("payment-receipt");
  if (!raw) return null;

  const decoded = JSON.parse(atob(raw));

  return {
    protocol: "mpp",
    amount: 0,
    asset: "",
    network: "",
    payerAddress: "",
    recipientAddress: "",
    txHash: decoded.tx || decoded.transaction || "",
    settlementSuccess: decoded.status === "settled",
  };
}

export function enrichWithManualAmount(
  payment: PaymentData | null,
  usdcAmount?: number,
): PaymentData | null {
  if (!payment && !usdcAmount) return null;

  if (!payment && usdcAmount) {
    return {
      protocol: "x402",
      amount: Math.round(usdcAmount * 1_000_000),
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      payerAddress: "",
      recipientAddress: "",
      txHash: "",
      settlementSuccess: true,
    };
  }

  if (payment && usdcAmount && payment.amount === 0) {
    payment.amount = Math.round(usdcAmount * 1_000_000);
    payment.asset = payment.asset || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  }

  return payment;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/payment-extractor.ts
git commit -m "feat(sdk): add x402/MPP payment header extraction"
```

---

## Task 10: SDK — Local Storage

**Files:**
- Create: `packages/sdk/src/storage.ts`

- [ ] **Step 1: Create storage.ts**

```typescript
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { CallRecord } from "./types.js";

export class PactStorage {
  private filePath: string;

  constructor(storagePath?: string) {
    this.filePath = storagePath || join(homedir(), ".pact-monitor", "records.jsonl");
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  append(record: CallRecord): void {
    appendFileSync(this.filePath, JSON.stringify(record) + "\n");
  }

  getUnsynced(): CallRecord[] {
    return this.readAll().filter((r) => !r.synced);
  }

  markSynced(count: number): void {
    const records = this.readAll();
    let marked = 0;
    for (const record of records) {
      if (!record.synced && marked < count) {
        record.synced = true;
        marked++;
      }
    }
    writeFileSync(this.filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  getStats(): {
    totalCalls: number;
    failureRate: number;
    avgLatencyMs: number;
    byProvider: Record<string, { calls: number; failureRate: number }>;
  } {
    const records = this.readAll();
    const total = records.length;
    const failures = records.filter((r) => r.classification !== "success").length;
    const avgLatency = total > 0
      ? records.reduce((sum, r) => sum + r.latencyMs, 0) / total
      : 0;

    const byProvider: Record<string, { calls: number; failures: number }> = {};
    for (const r of records) {
      if (!byProvider[r.hostname]) byProvider[r.hostname] = { calls: 0, failures: 0 };
      byProvider[r.hostname].calls++;
      if (r.classification !== "success") byProvider[r.hostname].failures++;
    }

    return {
      totalCalls: total,
      failureRate: total > 0 ? failures / total : 0,
      avgLatencyMs: Math.round(avgLatency),
      byProvider: Object.fromEntries(
        Object.entries(byProvider).map(([k, v]) => [
          k,
          { calls: v.calls, failureRate: v.calls > 0 ? v.failures / v.calls : 0 },
        ]),
      ),
    };
  }

  getRecords(options?: { limit?: number; provider?: string }): CallRecord[] {
    let records = this.readAll();
    if (options?.provider) {
      records = records.filter((r) => r.hostname === options.provider);
    }
    if (options?.limit) {
      records = records.slice(-options.limit);
    }
    return records;
  }

  private readAll(): CallRecord[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as CallRecord);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/storage.ts
git commit -m "feat(sdk): add JSON lines local storage with stats queries"
```

---

## Task 11: SDK — Fetch Wrapper

**Files:**
- Create: `packages/sdk/src/wrapper.ts`

- [ ] **Step 1: Create wrapper.ts**

```typescript
import type { CallRecord, PactConfig, PactFetchOptions } from "./types.js";
import { classify } from "./classifier.js";
import { extractPaymentData, enrichWithManualAmount } from "./payment-extractor.js";
import { PactStorage } from "./storage.js";
import { PactSync } from "./sync.js";

export class PactMonitor {
  private config: Required<PactConfig>;
  private storage: PactStorage;
  private sync: PactSync | null = null;

  constructor(config: PactConfig = {}) {
    this.config = {
      apiKey: config.apiKey || "",
      backendUrl: config.backendUrl || "https://pactnetwork.io",
      syncEnabled: config.syncEnabled ?? false,
      syncIntervalMs: config.syncIntervalMs ?? 30_000,
      syncBatchSize: config.syncBatchSize ?? 100,
      latencyThresholdMs: config.latencyThresholdMs ?? 5_000,
      storagePath: config.storagePath || "",
    };

    this.storage = new PactStorage(this.config.storagePath || undefined);

    if (this.config.syncEnabled && this.config.apiKey) {
      this.sync = new PactSync(
        this.storage,
        this.config.backendUrl,
        this.config.apiKey,
        this.config.syncIntervalMs,
        this.config.syncBatchSize,
      );
      this.sync.start();
    }
  }

  async fetch(
    url: string | URL,
    init?: RequestInit,
    pactOptions?: PactFetchOptions,
  ): Promise<Response> {
    const urlStr = url.toString();
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    const endpoint = parsed.pathname;

    const start = Date.now();
    let response: Response;
    let networkError = false;

    try {
      response = await globalThis.fetch(url, init);
    } catch (err) {
      networkError = true;
      // Record the failure but rethrow so the agent sees the original error
      const latencyMs = Date.now() - start;
      try {
        this.recordCall(hostname, endpoint, 0, latencyMs, networkError, null, null, pactOptions);
      } catch { /* golden rule: never break the agent */ }
      throw err;
    }

    const latencyMs = Date.now() - start;

    try {
      let body: unknown;
      if (pactOptions?.expectedSchema) {
        try {
          body = await response.clone().json();
        } catch {
          body = undefined;
        }
      }

      this.recordCall(
        hostname, endpoint, response.status, latencyMs,
        networkError, response.headers, body, pactOptions,
      );
    } catch { /* golden rule: never break the agent */ }

    return response;
  }

  private recordCall(
    hostname: string,
    endpoint: string,
    statusCode: number,
    latencyMs: number,
    networkError: boolean,
    headers: Headers | null,
    body: unknown,
    pactOptions?: PactFetchOptions,
  ): void {
    const classification = classify(
      statusCode,
      latencyMs,
      this.config.latencyThresholdMs,
      body,
      pactOptions?.expectedSchema,
      networkError,
    );

    let payment = headers ? extractPaymentData(headers) : null;
    payment = enrichWithManualAmount(payment, pactOptions?.usdcAmount);

    const record: CallRecord = {
      hostname,
      endpoint,
      timestamp: new Date().toISOString(),
      statusCode,
      latencyMs,
      classification,
      payment,
      synced: false,
    };

    this.storage.append(record);
  }

  getStats() {
    return this.storage.getStats();
  }

  getRecords(options?: { limit?: number; provider?: string }) {
    return this.storage.getRecords(options);
  }

  shutdown(): void {
    if (this.sync) {
      this.sync.flush();
      this.sync.stop();
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/wrapper.ts
git commit -m "feat(sdk): add fetch wrapper with payment extraction and classification"
```

---

## Task 12: SDK — Batch Sync & Barrel Export

**Files:**
- Create: `packages/sdk/src/sync.ts`
- Create: `packages/sdk/src/index.ts`

- [ ] **Step 1: Create sync.ts**

```typescript
import type { CallRecord } from "./types.js";
import type { PactStorage } from "./storage.js";

export class PactSync {
  private storage: PactStorage;
  private backendUrl: string;
  private apiKey: string;
  private intervalMs: number;
  private batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    storage: PactStorage,
    backendUrl: string,
    apiKey: string,
    intervalMs: number,
    batchSize: number,
  ) {
    this.storage = storage;
    this.backendUrl = backendUrl;
    this.apiKey = apiKey;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch(() => { /* retry next interval */ });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<void> {
    const unsynced = this.storage.getUnsynced();
    if (unsynced.length === 0) return;

    const batch = unsynced.slice(0, this.batchSize);
    const payload = {
      records: batch.map((r) => ({
        hostname: r.hostname,
        endpoint: r.endpoint,
        timestamp: r.timestamp,
        status_code: r.statusCode,
        latency_ms: r.latencyMs,
        classification: r.classification,
        payment_protocol: r.payment?.protocol ?? null,
        payment_amount: r.payment?.amount ?? null,
        payment_asset: r.payment?.asset ?? null,
        payment_network: r.payment?.network ?? null,
        payer_address: r.payment?.payerAddress ?? null,
        recipient_address: r.payment?.recipientAddress ?? null,
        tx_hash: r.payment?.txHash ?? null,
        settlement_success: r.payment?.settlementSuccess ?? null,
      })),
    };

    const response = await globalThis.fetch(`${this.backendUrl}/api/v1/records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      this.storage.markSynced(batch.length);
    }
  }
}
```

- [ ] **Step 2: Create index.ts (barrel export)**

```typescript
import { PactMonitor } from "./wrapper.js";
import type { PactConfig, PactFetchOptions } from "./types.js";

export function pactMonitor(config?: PactConfig): PactMonitor {
  return new PactMonitor(config);
}

export { PactMonitor } from "./wrapper.js";
export type {
  CallRecord,
  Classification,
  PaymentData,
  PactConfig,
  PactFetchOptions,
  ExpectedSchema,
} from "./types.js";
```

- [ ] **Step 3: Build SDK**

```bash
cd packages/sdk && npx tsc
```

Expected: Compiles with no errors. `dist/` directory created with `.js` and `.d.ts` files.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/sync.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): add batch sync, barrel export — SDK complete"
```

---

## Task 13: Scorecard — Project Setup & Design System

**Files:**
- Create: `packages/scorecard/index.html`
- Create: `packages/scorecard/vite.config.ts`
- Create: `packages/scorecard/tailwind.config.ts`
- Create: `packages/scorecard/postcss.config.js`
- Create: `packages/scorecard/src/main.tsx`
- Create: `packages/scorecard/src/styles/global.css`

- [ ] **Step 1: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pact Network — Reliability Scorecard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inria+Sans:wght@400;700&family=Inria+Serif:wght@400;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
```

- [ ] **Step 3: Create tailwind.config.ts**

```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#151311",
        copper: "#B87333",
        sienna: "#C9553D",
        slate: "#5A6B7A",
        surface: "#1A1917",
        "surface-light": "#242220",
        border: "#333330",
      },
      fontFamily: {
        serif: ['"Inria Serif"', "serif"],
        sans: ['"Inria Sans"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      borderRadius: {
        DEFAULT: "0px",
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 4: Create postcss.config.js**

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Create global.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-bg text-neutral-200 font-sans antialiased;
    margin: 0;
  }

  h1, h2, h3 {
    @apply font-serif;
  }
}
```

- [ ] **Step 6: Create main.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Run dev server**

```bash
cd packages/scorecard && npx vite
```

Expected: Dev server starts, blank dark page at localhost:5173.

- [ ] **Step 8: Commit**

```bash
git add packages/scorecard/index.html packages/scorecard/vite.config.ts packages/scorecard/tailwind.config.ts packages/scorecard/postcss.config.js packages/scorecard/src/styles/global.css packages/scorecard/src/main.tsx
git commit -m "feat(scorecard): project setup with Vite, Tailwind, design system"
```

---

## Task 14: Scorecard — API Client & Data Hook

**Files:**
- Create: `packages/scorecard/src/api/client.ts`
- Create: `packages/scorecard/src/hooks/useProviders.ts`

- [ ] **Step 1: Create client.ts**

```typescript
export interface ProviderSummary {
  id: string;
  name: string;
  category: string;
  total_calls: number;
  failure_rate: number;
  avg_latency_ms: number;
  uptime: number;
  insurance_rate: number;
  tier: "RELIABLE" | "ELEVATED" | "HIGH_RISK";
  total_payment_amount: number;
  lost_payment_amount: number;
}

export interface ProviderDetail extends ProviderSummary {
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  failure_breakdown: Record<string, number>;
  top_endpoints: Array<{ endpoint: string; calls: number; failure_rate: number }>;
  payment_breakdown: Record<string, { calls: number; total_amount: number; lost_amount: number }>;
}

export interface TimeseriesPoint {
  bucket: string;
  calls: number;
  failures: number;
  failure_rate: number;
}

export interface TimeseriesData {
  provider_id: string;
  granularity: "hourly" | "daily";
  data: TimeseriesPoint[];
}

const BASE = "/api/v1";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getProviders: () => get<ProviderSummary[]>("/providers"),
  getProvider: (id: string) => get<ProviderDetail>(`/providers/${id}`),
  getTimeseries: (id: string, granularity = "hourly", days = 7) =>
    get<TimeseriesData>(`/providers/${id}/timeseries?granularity=${granularity}&days=${days}`),
};
```

- [ ] **Step 2: Create useProviders.ts**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api, type ProviderSummary } from "../api/client";

export function useProviders(refreshIntervalMs = 30_000) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getProviders();
      setProviders(data);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [refresh, refreshIntervalMs]);

  return { providers, loading, error, lastUpdated, refresh };
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/scorecard/src/api/client.ts packages/scorecard/src/hooks/useProviders.ts
git commit -m "feat(scorecard): add typed API client and auto-refresh hook"
```

---

## Task 15: Scorecard — App Shell & Rankings Page

**Files:**
- Create: `packages/scorecard/src/App.tsx`
- Create: `packages/scorecard/src/components/ProviderTable.tsx`

- [ ] **Step 1: Create App.tsx**

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ProviderTable } from "./components/ProviderTable";
import { ProviderDetail } from "./components/ProviderDetail";

export function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg">
        <header className="border-b border-border px-8 py-4">
          <h1 className="font-serif text-xl text-neutral-200 tracking-wide">
            Pact Network
          </h1>
          <p className="text-sm text-neutral-500 font-sans">
            API Reliability Scorecard
          </p>
        </header>
        <main className="px-8 py-6">
          <Routes>
            <Route path="/" element={<ProviderTable />} />
            <Route path="/provider/:id" element={<ProviderDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
```

- [ ] **Step 2: Create ProviderTable.tsx**

```tsx
import { useNavigate } from "react-router-dom";
import { useProviders } from "../hooks/useProviders";

const tierColor: Record<string, string> = {
  RELIABLE: "text-slate border-slate",
  ELEVATED: "text-copper border-copper",
  HIGH_RISK: "text-sienna border-sienna",
};

function formatUsd(lamports: number): string {
  return `$${(lamports / 1_000_000).toFixed(2)}`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function ProviderTable() {
  const { providers, loading, error, lastUpdated } = useProviders();
  const navigate = useNavigate();

  if (loading) {
    return <p className="text-neutral-500 font-mono text-sm">Loading providers...</p>;
  }

  if (error) {
    return <p className="text-sienna font-mono text-sm">Error: {error}</p>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-serif text-lg text-neutral-300">Provider Rankings</h2>
        {lastUpdated && (
          <span className="text-xs text-neutral-600 font-mono">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      <table className="w-full border-collapse font-mono text-sm">
        <thead>
          <tr className="border-b border-border text-neutral-500 text-xs uppercase tracking-widest">
            <th className="text-left py-3 px-2">Provider</th>
            <th className="text-left py-3 px-2">Category</th>
            <th className="text-right py-3 px-2">Calls</th>
            <th className="text-right py-3 px-2">Failure</th>
            <th className="text-right py-3 px-2">Latency</th>
            <th className="text-right py-3 px-2">Uptime</th>
            <th className="text-right py-3 px-2 text-copper">Ins. Rate</th>
            <th className="text-right py-3 px-2">$ at Risk</th>
            <th className="text-left py-3 px-2">Tier</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr
              key={p.id}
              onClick={() => navigate(`/provider/${p.id}`)}
              className="border-b border-border/50 cursor-pointer hover:bg-surface-light transition-colors"
            >
              <td className="py-3 px-2 text-neutral-200 font-sans font-bold">{p.name}</td>
              <td className="py-3 px-2 text-neutral-500">{p.category}</td>
              <td className="py-3 px-2 text-right text-neutral-300">{p.total_calls.toLocaleString()}</td>
              <td className="py-3 px-2 text-right text-neutral-300">{formatPct(p.failure_rate)}</td>
              <td className="py-3 px-2 text-right text-neutral-300">{p.avg_latency_ms}ms</td>
              <td className="py-3 px-2 text-right text-neutral-300">{formatPct(p.uptime)}</td>
              <td className="py-3 px-2 text-right text-copper font-bold">{formatPct(p.insurance_rate)}</td>
              <td className="py-3 px-2 text-right text-neutral-300">
                {p.lost_payment_amount > 0 ? formatUsd(p.lost_payment_amount) : "-"}
              </td>
              <td className="py-3 px-2">
                <span className={`border px-2 py-0.5 text-xs uppercase tracking-widest ${tierColor[p.tier] || "text-neutral-500 border-neutral-500"}`}>
                  {p.tier.replace("_", " ")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Run dev server and verify**

Start backend (with seeded data) and scorecard:
```bash
# Terminal 1: backend
cd packages/backend && npx tsx src/index.ts

# Terminal 2: scorecard
cd packages/scorecard && npx vite
```

Open http://localhost:5173 — should show dark page with rankings table.

- [ ] **Step 4: Commit**

```bash
git add packages/scorecard/src/App.tsx packages/scorecard/src/components/ProviderTable.tsx
git commit -m "feat(scorecard): add app shell and provider rankings table"
```

---

## Task 16: Scorecard — Provider Detail Page & Charts

**Files:**
- Create: `packages/scorecard/src/components/ProviderDetail.tsx`
- Create: `packages/scorecard/src/components/Charts/FailureTimeline.tsx`
- Create: `packages/scorecard/src/components/Charts/FailureBreakdown.tsx`

- [ ] **Step 1: Create FailureTimeline.tsx**

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { TimeseriesPoint } from "../../api/client";

export function FailureTimeline({ data }: { data: TimeseriesPoint[] }) {
  const formatted = data.map((d) => ({
    ...d,
    label: new Date(d.bucket).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric" }),
    rate: parseFloat((d.failure_rate * 100).toFixed(2)),
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={formatted}>
        <XAxis dataKey="label" tick={{ fill: "#5A6B7A", fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis tick={{ fill: "#5A6B7A", fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          contentStyle={{ background: "#1A1917", border: "1px solid #333330", color: "#ccc", fontFamily: "JetBrains Mono", fontSize: 12 }}
          formatter={(value: number) => [`${value}%`, "Failure Rate"]}
        />
        <Bar dataKey="rate" fill="#B87333" />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Create FailureBreakdown.tsx**

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const COLORS: Record<string, string> = {
  timeout: "#C9553D",
  error: "#B87333",
  schema_mismatch: "#5A6B7A",
};

export function FailureBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const data = Object.entries(breakdown).map(([key, value]) => ({
    name: key,
    count: value,
  }));

  if (data.length === 0) {
    return <p className="text-neutral-600 text-sm font-mono">No failures recorded</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical">
        <XAxis type="number" tick={{ fill: "#5A6B7A", fontSize: 10 }} />
        <YAxis dataKey="name" type="category" tick={{ fill: "#ccc", fontSize: 11, fontFamily: "JetBrains Mono" }} width={120} />
        <Tooltip
          contentStyle={{ background: "#1A1917", border: "1px solid #333330", color: "#ccc", fontFamily: "JetBrains Mono", fontSize: 12 }}
        />
        <Bar dataKey="count">
          {data.map((entry) => (
            <Cell key={entry.name} fill={COLORS[entry.name] || "#5A6B7A"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 3: Create ProviderDetail.tsx**

```tsx
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, type ProviderDetail as ProviderDetailType, type TimeseriesData } from "../api/client";
import { FailureTimeline } from "./Charts/FailureTimeline";
import { FailureBreakdown } from "./Charts/FailureBreakdown";

const tierColor: Record<string, string> = {
  RELIABLE: "text-slate border-slate",
  ELEVATED: "text-copper border-copper",
  HIGH_RISK: "text-sienna border-sienna",
};

function formatUsd(lamports: number): string {
  return `$${(lamports / 1_000_000).toFixed(2)}`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface border border-border p-4">
      <div className="text-xs text-neutral-500 uppercase tracking-widest font-sans">{label}</div>
      <div className={`font-mono text-lg mt-1 ${color || "text-neutral-200"}`}>{value}</div>
    </div>
  );
}

export function ProviderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ProviderDetailType | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([api.getProvider(id), api.getTimeseries(id)])
      .then(([p, ts]) => {
        setProvider(p);
        setTimeseries(ts);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="text-neutral-500 font-mono text-sm">Loading...</p>;
  if (!provider) return <p className="text-sienna font-mono text-sm">Provider not found</p>;

  return (
    <div>
      <button
        onClick={() => navigate("/")}
        className="text-sm text-neutral-500 hover:text-neutral-300 font-sans mb-4 border border-border px-3 py-1"
      >
        Back to rankings
      </button>

      <div className="mb-6">
        <h2 className="font-serif text-2xl text-neutral-200">{provider.name}</h2>
        <p className="text-sm text-neutral-500 font-sans">{provider.category}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
        <StatCard label="Failure Rate" value={formatPct(provider.failure_rate)} color="text-copper" />
        <StatCard label="Avg Latency" value={`${provider.avg_latency_ms}ms`} />
        <StatCard label="Insurance Rate" value={formatPct(provider.insurance_rate)} color="text-copper" />
        <StatCard label="$ Lost" value={formatUsd(provider.lost_payment_amount)} color="text-sienna" />
        <div className="bg-surface border border-border p-4">
          <div className="text-xs text-neutral-500 uppercase tracking-widest font-sans">Tier</div>
          <span className={`border px-2 py-0.5 text-sm uppercase tracking-widest font-mono mt-1 inline-block ${tierColor[provider.tier] || ""}`}>
            {provider.tier.replace("_", " ")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-4">Failure Rate Over Time</h3>
          {timeseries && <FailureTimeline data={timeseries.data} />}
        </div>
        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-4">Failure Breakdown</h3>
          <FailureBreakdown breakdown={provider.failure_breakdown} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-4">Top Endpoints</h3>
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="text-neutral-500 text-xs border-b border-border">
                <th className="text-left py-2">Endpoint</th>
                <th className="text-right py-2">Calls</th>
                <th className="text-right py-2">Failure</th>
              </tr>
            </thead>
            <tbody>
              {provider.top_endpoints.map((ep) => (
                <tr key={ep.endpoint} className="border-b border-border/50">
                  <td className="py-2 text-neutral-300">{ep.endpoint}</td>
                  <td className="py-2 text-right text-neutral-400">{ep.calls.toLocaleString()}</td>
                  <td className="py-2 text-right text-copper">{formatPct(ep.failure_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-4">Payment Protocols</h3>
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="text-neutral-500 text-xs border-b border-border">
                <th className="text-left py-2">Protocol</th>
                <th className="text-right py-2">Calls</th>
                <th className="text-right py-2">Total</th>
                <th className="text-right py-2">Lost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(provider.payment_breakdown).map(([proto, data]) => (
                <tr key={proto} className="border-b border-border/50">
                  <td className="py-2 text-neutral-300">{proto}</td>
                  <td className="py-2 text-right text-neutral-400">{data.calls.toLocaleString()}</td>
                  <td className="py-2 text-right text-neutral-400">{formatUsd(data.total_amount)}</td>
                  <td className="py-2 text-right text-sienna">{formatUsd(data.lost_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/scorecard/src/components/ProviderDetail.tsx packages/scorecard/src/components/Charts/FailureTimeline.tsx packages/scorecard/src/components/Charts/FailureBreakdown.tsx
git commit -m "feat(scorecard): add provider detail page with charts — scorecard complete"
```

---

## Task 17: Data Seeding Script

**Files:**
- Create: `packages/backend/src/scripts/seed.ts`

- [ ] **Step 1: Create seed.ts**

```typescript
import "dotenv/config";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";
import { randomBytes } from "crypto";

const PROVIDERS = [
  { name: "Helius", category: "RPC", base_url: "api.helius.xyz", failureRate: 0.003, avgLatency: 95, latencyStddev: 30 },
  { name: "QuickNode", category: "RPC", base_url: "solana-mainnet.quiknode.pro", failureRate: 0.001, avgLatency: 120, latencyStddev: 40 },
  { name: "Jupiter", category: "DEX Aggregator", base_url: "quote-api.jup.ag", failureRate: 0.015, avgLatency: 320, latencyStddev: 150 },
  { name: "CoinGecko", category: "Price Feed", base_url: "api.coingecko.com", failureRate: 0.03, avgLatency: 250, latencyStddev: 100 },
  { name: "DexScreener", category: "Price Feed", base_url: "api.dexscreener.com", failureRate: 0.02, avgLatency: 380, latencyStddev: 200 },
];

const ENDPOINTS: Record<string, string[]> = {
  "api.helius.xyz": ["/v0/transactions", "/v0/addresses", "/v0/token-metadata"],
  "solana-mainnet.quiknode.pro": ["/", "/getAccountInfo", "/getBalance"],
  "quote-api.jup.ag": ["/v6/quote", "/v6/swap", "/v6/tokens"],
  "api.coingecko.com": ["/api/v3/simple/price", "/api/v3/coins/markets", "/api/v3/coins/solana"],
  "api.dexscreener.com": ["/latest/dex/tokens", "/latest/dex/pairs", "/latest/dex/search"],
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function randomGaussian(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1, Math.round(mean + z * stddev));
}

function randomClassification(failureRate: number, latency: number): string {
  const roll = Math.random();
  if (roll < failureRate * 0.5) return "error";
  if (roll < failureRate * 0.8) return "timeout";
  if (roll < failureRate) return "schema_mismatch";
  if (latency > 5000) return "timeout";
  return "success";
}

function randomProtocol(): "x402" | "mpp" | null {
  const roll = Math.random();
  if (roll < 0.6) return "x402";
  if (roll < 0.85) return "mpp";
  return null;
}

async function seed() {
  await initDb();
  console.log("Seeding database...");

  // Create seed API key
  const seedKey = `pact_seed_${randomBytes(12).toString("hex")}`;
  await query(
    "INSERT INTO api_keys (key_hash, label) VALUES ($1, $2) ON CONFLICT (key_hash) DO NOTHING",
    [hashKey(seedKey), "seeder"],
  );
  console.log(`Seed API key: ${seedKey}`);

  // Create providers
  const providerIds: Record<string, string> = {};
  for (const p of PROVIDERS) {
    const result = await query<{ id: string }>(
      "INSERT INTO providers (name, category, base_url) VALUES ($1, $2, $3) ON CONFLICT (base_url) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [p.name, p.category, p.base_url],
    );
    providerIds[p.base_url] = result.rows[0].id;
  }

  // Generate 7 days of historical records
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  let totalRecords = 0;

  for (const provider of PROVIDERS) {
    const endpoints = ENDPOINTS[provider.base_url];
    const recordsForProvider = 1500 + Math.floor(Math.random() * 1500); // 1500-3000 per provider

    for (let i = 0; i < recordsForProvider; i++) {
      const timestamp = new Date(sevenDaysAgo + Math.random() * (now - sevenDaysAgo));

      // Higher failure rates during peak hours (12-18 UTC)
      const hour = timestamp.getUTCHours();
      const peakMultiplier = (hour >= 12 && hour <= 18) ? 1.5 : 1.0;
      const effectiveFailureRate = provider.failureRate * peakMultiplier;

      const latency = randomGaussian(provider.avgLatency, provider.latencyStddev);
      const classification = randomClassification(effectiveFailureRate, latency);
      const statusCode = classification === "error" ? (Math.random() > 0.5 ? 500 : 503) :
                         classification === "success" || classification === "schema_mismatch" || classification === "timeout" ? 200 : 0;
      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
      const protocol = randomProtocol();
      const paymentAmount = protocol ? Math.round((0.001 + Math.random() * 0.01) * 1_000_000) : null;

      await query(
        `INSERT INTO call_records (
          provider_id, endpoint, timestamp, status_code, latency_ms,
          classification, payment_protocol, payment_amount, payment_asset,
          payment_network, payer_address, recipient_address, tx_hash,
          settlement_success, agent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          providerIds[provider.base_url],
          endpoint,
          timestamp.toISOString(),
          statusCode,
          latency,
          classification,
          protocol,
          paymentAmount,
          protocol ? USDC_MINT : null,
          protocol ? SOLANA_NETWORK : null,
          protocol ? `Agent${randomBytes(4).toString("hex")}` : null,
          protocol ? `Provider${randomBytes(4).toString("hex")}` : null,
          protocol ? randomBytes(32).toString("hex") : null,
          protocol ? (classification === "success") : null,
          "seeder",
        ],
      );
      totalRecords++;
    }

    console.log(`  ${provider.name}: ${recordsForProvider} records`);
  }

  console.log(`\nSeeding complete. Total records: ${totalRecords}`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the seed script**

```bash
cd packages/backend && npx tsx src/scripts/seed.ts
```

Expected: Prints each provider with record count, total 10,000+.

- [ ] **Step 3: Verify seeded data via API**

```bash
curl http://localhost:3000/api/v1/providers | jq '.[].name'
```

Expected: Lists all 5 providers.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/scripts/seed.ts
git commit -m "feat(backend): add data seeding script for 5 Solana providers"
```

---

## Task 18: Deployment Configs

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`
- Create: `packages/backend/Dockerfile`
- Create: `packages/scorecard/Dockerfile`

- [ ] **Step 1: Create packages/backend/Dockerfile**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npx tsc

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/schema.sql ./dist/schema.sql
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create packages/scorecard/Dockerfile**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts tailwind.config.ts postcss.config.js index.html ./
COPY src ./src
RUN npm install && npm run build

FROM caddy:2-alpine
COPY --from=builder /app/dist /srv/scorecard
```

- [ ] **Step 3: Create deploy/Caddyfile**

```
pactnetwork.io {
    handle /api/* {
        reverse_proxy backend:3000
    }

    handle /health {
        reverse_proxy backend:3000
    }

    handle {
        root * /srv/scorecard
        try_files {path} /index.html
        file_server
    }
}
```

- [ ] **Step 4: Create deploy/docker-compose.yml**

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: pact
      POSTGRES_PASSWORD: pact
      POSTGRES_DB: pact
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped

  backend:
    build: ../packages/backend
    depends_on:
      - postgres
    environment:
      DATABASE_URL: postgresql://pact:pact@postgres:5432/pact
      PORT: "3000"
    expose:
      - "3000"
    restart: unless-stopped

  scorecard:
    build: ../packages/scorecard
    volumes:
      - scorecard_dist:/srv/scorecard

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
      - scorecard_dist:/srv/scorecard
    depends_on:
      - backend
      - scorecard
    restart: unless-stopped

volumes:
  pgdata:
  caddy_data:
  caddy_config:
  scorecard_dist:
```

- [ ] **Step 5: Commit**

```bash
git add deploy/ packages/backend/Dockerfile packages/scorecard/Dockerfile
git commit -m "feat(deploy): add Docker Compose, Dockerfiles, and Caddyfile"
```

---

## Task 19: CLAUDE.md Update & Final Cleanup

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md to reflect actual implementation**

Update the CLAUDE.md with the final tech stack, build commands, and project structure matching what was built. Key changes:
- Backend framework: Fastify (not Hono)
- Database: PostgreSQL (not SQLite)
- Project structure uses `packages/` directory
- Add `deploy/` directory reference
- Update build/run commands

- [ ] **Step 2: Run full integration test**

Start everything locally:
```bash
# Terminal 1: PostgreSQL (if not already running)
docker run -d --name pact-pg -e POSTGRES_USER=pact -e POSTGRES_PASSWORD=pact -e POSTGRES_DB=pact -p 5432:5432 postgres:16-alpine

# Terminal 2: Backend
cd packages/backend && npx tsx src/index.ts

# Terminal 3: Seed data
cd packages/backend && npx tsx src/scripts/seed.ts

# Terminal 4: Scorecard
cd packages/scorecard && npx vite
```

Open http://localhost:5173 and verify:
- Rankings table loads with 5 providers
- Insurance rates and tiers display correctly
- Clicking a provider opens the detail page
- Charts render with data
- Data auto-refreshes (check updated timestamp)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with final tech stack and project structure"
```

---

## Summary

| Task | Component | Description |
|------|-----------|------------|
| 1 | Root | Monorepo scaffolding, package configs |
| 2 | Backend | PostgreSQL schema + connection |
| 3 | Backend | Insurance rate formula + tiers |
| 4 | Backend | API key auth + key generation |
| 5 | Backend | POST /api/v1/records batch ingest |
| 6 | Backend | GET providers list, detail, timeseries |
| 7 | Backend | Health endpoint + server bootstrap |
| 8 | SDK | Types + classifier |
| 9 | SDK | Payment extractor (x402/MPP) |
| 10 | SDK | Local JSON lines storage |
| 11 | SDK | Fetch wrapper |
| 12 | SDK | Batch sync + barrel export |
| 13 | Scorecard | Vite + Tailwind + design system setup |
| 14 | Scorecard | API client + auto-refresh hook |
| 15 | Scorecard | App shell + rankings table |
| 16 | Scorecard | Provider detail + charts |
| 17 | Backend | Data seeding script |
| 18 | Deploy | Docker Compose + Caddy configs |
| 19 | Root | CLAUDE.md update + integration test |

**Parallelization:** Tasks 2-7 (backend), 8-12 (SDK), and 13-16 (scorecard) can be worked on in parallel by separate crew members since they're independent packages. Task 17 (seeding) requires the backend. Task 18 requires both backend and scorecard Dockerfiles.
