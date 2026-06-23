# PS-Managment

Multi-tenant SaaS for managing **gaming cafés** (PlayStation lounges). A single platform serving many independent café businesses — each with its own branches, devices, staff, pricing, shifts, and reports — built as a monorepo. The earlier single-café app (`Pochinki`) is a **trial we learn from, not a blueprint**: we reuse genuinely sound ideas (money model, pricing math, offline sync) and build this one fresh, more advanced, and better.

## What this is

| Surface | Stack | Who uses it |
| --- | --- | --- |
| **Mobile app** | Expo / React Native (`apps/mobile`) | Counter staff & managers — run shifts, sessions, orders |
| **Web dashboard** | Next.js (`apps/web`) | Café owners — pricing, products, staff, reports |
| **Super-admin portal** | Next.js (`apps/web`) | Platform operators — tenant lifecycle, billing, support |
| **Shared core** | TypeScript (`packages/core`) | Pure pricing/money/time/inventory logic, no UI |
| **Backend** | Supabase — Postgres + Auth + RLS (`supabase/`) | Multi-tenant data, isolation enforced in the DB |

## Repository layout

```
PS-Managment/
  packages/core/     # pure logic: pricing engine, money (piastres), time (Cairo TZ), inventory, types
  apps/mobile/       # Expo Router app (counter / manager)
  apps/web/          # Next.js: owner dashboard + super-admin portal
  supabase/          # migrations, RLS policies, edge functions, seed
  docs/              # ROADMAP, BACKLOG, specs, ADRs (docs/adr)
  .claude/           # the AI agent "company": agents, workflows, skills, settings
  CLAUDE.md          # domain knowledge + conventions + agent-workflow contract
```

## The AI agent "company"

This project is built by a team of specialized AI agents orchestrated through a repeatable workflow:

> **spec → design → build (parallel) → test → review → agents debate → human approves**

See [`docs/AGENTS.md`](docs/AGENTS.md) for the org chart and [`.claude/workflows/`](.claude/workflows/) for the orchestration scripts. The human (project owner) approves at the end of every phase. The full roadmap is in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Domain at a glance

- **Tenancy:** Tenant (café business) → Branch (location) → Devices / Staff / Shifts / Sessions.
- **Money:** integer **piastres** (100 = 1 EGP). No floating point. Ever.
- **Time:** stored UTC; computed in **Africa/Cairo**. Timers derive from timestamps, never `setInterval`.
- **Localization:** Arabic-first, RTL.
- **Pricing:** open-meter / prepaid / fixed-match, resolved by owner-configured rate rules.

Read [`CLAUDE.md`](CLAUDE.md) before contributing (human or agent).

## Status

**Phase 1 — the factory** (agent team + workflows + scaffolding). Product phases follow; nothing here depends on or modifies the `Pochinki` trial project.
