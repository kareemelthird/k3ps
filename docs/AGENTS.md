# The PS-Managment AI "Company"

This project is built by a team of specialized agents, run like a software company. Each agent has one clear job, its own skills, and defined hand-offs. The **human (project owner) approves at the end of every phase.**

## Org chart

| Agent | Role | Owns | Key skills |
| --- | --- | --- | --- |
| `product-manager` | Specs & backlog | `docs/specs`, `docs/BACKLOG.md` | deep-research |
| `architect` | System/DB design, **tenant isolation**, ADRs | `docs/adr`, `docs/design` | adr-write, deep-research, MS-Learn |
| `ux-designer` | RTL UX, design system, component contracts | `docs/design` | ui-ux-pro-max, magic MCP |
| `core-engineer` | Pure logic: pricing/money/time/inventory | `packages/core` | pricing-engine-guard, ps-verify |
| `backend-engineer` | Schema, migrations, RLS, edge funcs | `supabase/` | supabase-migrate, rls-tenant-audit, ps-verify |
| `mobile-engineer` | Expo counter/manager app | `apps/mobile` | rtl-i18n-check, ps-verify |
| `web-engineer` | Owner dashboard + super-admin | `apps/web` | rtl-i18n-check, ps-verify |
| `qa-tester` | Tests, verification, acceptance gating | tests across repo | ps-verify, pricing-engine-guard, rls-tenant-audit, verify |
| `code-reviewer` | Correctness + cleanliness (read-only) | review findings | code-review, simplify |
| `security-reviewer` | Auth/RLS/isolation audit (read-only) | security sign-off | security-review, rls-tenant-audit |
| `devops` | Monorepo tooling, CI/CD, builds, env | tooling, CI | ps-verify |
| `docs-writer` | Keeps docs/CLAUDE.md accurate | `docs/`, READMEs | — |

The **orchestrator** is the main Claude Code session driving the workflows below. It coordinates, mediates the debate, and assembles the human-gate summary.

## The workflow (per feature / phase)

Run with the Workflow tool: `.claude/workflows/feature.js`.

```
1. Spec        product-manager  -> testable acceptance criteria (docs/specs)
2. Design      architect + ux-designer (parallel) -> tech design + ADR + UX contracts
3. Build       core/backend/mobile/web engineers (parallel, worktree-isolated)
4. Test        qa-tester -> ps-verify + every acceptance criterion, honest report
5. Review      code-reviewer + security-reviewer (parallel)
                 -> each finding adversarially verified (skeptic tries to refute)
6. Reconcile   verified blockers routed back to the owning engineer; "the debate"
7. Gate        orchestrator -> concise summary; HUMAN APPROVES before next phase
```

Supporting workflows:
- `architecture-decision.js` — judge panel for hard, hard-to-reverse decisions (e.g. tenant isolation), ending in an ADR for human approval.
- `bugfix.js` — reproduce → adversarially confirm root cause → fix (isolated) → QA re-verify.

## Rules of engagement
- **Reuse first** — the Pochinki trial already solved pricing/money/time/inventory; port, don't reinvent.
- **Stay in your lane** — own your paths; hand off across boundaries.
- **Findings get verified** — no unverified claim becomes work.
- **Tenant isolation is sacred** — every RLS change needs `security-reviewer` sign-off.
- **Human gate is mandatory** — agents never self-approve a phase.

See `CLAUDE.md` for the domain rules every agent must honor.
