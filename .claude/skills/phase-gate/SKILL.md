---
name: phase-gate
description: Assemble the concise human-approval summary at the end of a phase or feature. Use when a feature workflow finishes and the human (project owner) must approve before the next phase. Produces a consistent gate report; never auto-approves.
allowed-tools: Read, Grep, Glob
---

# phase-gate

The human (project owner) approves at the end of every phase (`CLAUDE.md` §8). This skill produces the concise, honest summary they review. **It never approves — it prepares the decision.**

## Gather
- The spec + acceptance criteria (`docs/specs/`), the QA report, the code + security review findings (and their adversarial verification), ADRs written, and what shipped per surface.

## Produce this summary
1. **Goal** — one line: what this phase set out to deliver.
2. **What was built** — per surface (core / backend / mobile / web), 1–2 lines each, with key file areas.
3. **Decisions** — ADRs written this phase (link), each with its one-line decision; flag any awaiting human choice.
4. **Test results** — `ps-verify` status, core coverage %, and **acceptance criteria: N/M passed** (list any failed with repro).
5. **Security** — `security-reviewer` verdict for any RLS/auth change (signed-off? leaks? — a tenant leak blocks the gate).
6. **Confirmed findings** — verified review findings by severity; blockers must be resolved (or explicitly accepted by the human).
7. **Residual risks / open questions** — what's deferred, what's uncertain.
8. **Ready?** — a boolean: green only if `ps-verify` passes, all acceptance criteria pass, no unresolved blockers, and security signed off. If not green, say exactly what's outstanding.

## Rules
- Be honest: surface failures, skips, and risks plainly. Don't inflate "done".
- End with: **"HUMAN APPROVAL REQUIRED before starting the next phase."** Do not proceed past the gate autonomously.

## Output
The structured summary above, scannable in under a minute, with links to specs/ADRs/reports.
