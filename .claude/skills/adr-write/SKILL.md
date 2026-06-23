---
name: adr-write
description: Write an Architecture Decision Record for PS-Managment. Use when making a non-trivial, hard-to-reverse technical decision (tenant isolation model, stack choice, schema strategy, auth model). Produces a numbered ADR in docs/adr/ following the project template.
allowed-tools: Read, Write, Edit, Grep, Glob
---

# adr-write

Capture significant decisions so the team (human + agent) understands the "why" later.

## When to write one
Any decision that is costly to reverse or shapes the architecture: tenant isolation model, package manager, database/schema strategy, auth/JWT-claim model, major dependency, API contract style.

## How
1. Find the next number in `docs/adr/` (zero-padded) and copy the structure from `docs/adr/0000-template.md`.
2. File: `docs/adr/NNNN-short-title.md`.
3. Fill every section:
   - **Status** — Proposed / Accepted / Superseded (link).
   - **Context** — the problem, constraints (link `CLAUDE.md` sections), and forces at play.
   - **Options considered** — at least 2, each with pros/cons and evidence. **Cite research** (URLs) where used.
   - **Decision** — what we chose and the single most important reason.
   - **Consequences** — what becomes easy, what becomes hard, follow-up work, and what must be verified (e.g. isolation tests).
4. Never rewrite an Accepted ADR — supersede it with a new one and link both ways.

## Output
The path of the ADR written and a one-paragraph summary for the human-gate. Decisions affecting tenancy/security must be flagged for `security-reviewer` and the human approver.
