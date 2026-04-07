# Pact Network

Pact Network is a parametric micro-insurance system for AI agent API payments on Solana. It monitors API provider reliability in real-time, computes actuarially-derived insurance rates from observed failure data, and publishes those rates on a public scorecard. The insurance rate is the product — everything else exists to make that number real, accurate, and public.

## Tech Stack

- **Language:** TypeScript (all packages)
- **Backend:** Hono (API server), SQLite (database)
- **Scorecard:** Vite + React (SPA dashboard)
- **SDK Storage:** JSON file (local on agent's machine)

## Monorepo Structure

```
sdk/        — @pact-network/monitor: TypeScript SDK wrapping fetch() to monitor API reliability
backend/    — @pact-network/backend: Hono API server aggregating monitoring data
scorecard/  — @pact-network/scorecard: Vite+React dashboard showing provider reliability rankings
docs/       — PRD and reference documents
```

## Design System

- **Background:** #151311 (dark)
- **Copper:** #B87333
- **Burnt Sienna:** #C9553D
- **Slate:** #5A6B7A
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)
- **Aesthetic:** Brutalist — zero/minimal border radius, no gradients, no emojis in code or UI

## Build & Run

```bash
# SDK
cd sdk && npm install && npm run build

# Backend
cd backend && npm install && npm run dev

# Scorecard
cd scorecard && npm install && npm run dev
```

## Conventions

- No emojis in code or UI
- All technical decisions are Alan's (the developer)
- Deadline: April 12, 2026 (Colosseum hackathon)
