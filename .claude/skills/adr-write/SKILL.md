---
name: adr-write
description: Write an Architecture Decision Record for PS-Managment. Use when making a non-trivial, hard-to-reverse technical decision (tenant isolation model, stack choice, schema strategy, auth model). Produces a numbered ADR in docs/adr/ following the project template.
allowed-tools: Read, Write, Edit, Grep, Glob
---

# adr-write

Capture significant decisions so the team (human + agent) understands the "why" later.

## When to write one
Any decision costly to reverse or that shapes the architecture: tenant isolation model, package manager, schema/migration strategy, auth/JWT-claim model, a major dependency, an API-contract style. Reversible details don't need an ADR.

## How
1. Find the next number in `docs/adr/` (zero-padded). File: `docs/adr/NNNN-short-title.md`. Copy the structure from `docs/adr/0000-template.md`.
2. Fill every section:
   - **Status** — Proposed / Accepted / Superseded by ADR-NNNN (link both ways).
   - **Context** — the problem, constraints (link `CLAUDE.md` and `docs/reference/*` sections), forces in tension.
   - **Options considered** — **≥2**, each with pros/cons and **cited evidence (URLs)**.
   - **Decision** — what was chosen and the single most important reason.
   - **Consequences** — what gets easy, what gets hard, follow-up work, and **what must be verified** (e.g. `rls-tenant-audit` isolation tests, performance) and who signs off (`security-reviewer` for tenancy/auth).
3. **Never rewrite an Accepted ADR** — supersede it with a new one and cross-link.

## Tie-in
For big decisions with multiple viable options, the orchestrator runs the **`architecture-decision`** workflow (judge panel) and this skill writes up the winner. Always feed runner-up strengths into Consequences.

## Output
The ADR path + a one-paragraph summary for the human gate. Tenancy/security decisions are flagged for `security-reviewer` and the human approver.
