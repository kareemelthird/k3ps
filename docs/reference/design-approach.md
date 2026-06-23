# Reference: design approach

PS-Managment gets a **fresh, modern design built with our design tooling** — not a copy of the Pochinki trial. The trial is a *learning input only* (see "Lessons" below); it is not a style guide to match.

## Design engine (use these — they are better than hand-rolling)
- **`ui-ux-pro-max` skill** — the primary design intelligence: styles, color systems, font pairings, spacing, UX guidelines, chart selection, accessibility, and stack-specific implementation (React Native, Next.js, Tailwind, shadcn/ui). Drive every design decision through it.
- **21st.dev magic MCP** (`mcp__magic__*`) — generate, refine, and find inspiration for real components (`21st_magic_component_builder` / `_refiner` / `_inspiration`), and `logo_search` for marks/icons. Use it to produce buildable component implementations from the chosen direction.

The `ux-designer` owns the design system and writes it to `docs/design/`; that generated system — not this file and not the trial — is the source of truth engineers build against.

## Product-level UX truths (these are the business + accessibility, keep regardless of aesthetic)
- **Arabic-first, RTL.** Mirror layouts; Arabic-Indic numerals for displayed money/counts; no clipped Arabic. (i18n via resources, never hardcoded.)
- **Counter-speed.** Used one-handed at a busy counter: large tap targets (~52px min is a good floor), minimal taps to start/close a session, a glanceable device grid.
- **Dark-friendly** environment (lounges are dim) — but the exact palette/theme is the ux-designer's call via the tooling, not a fixed identity.
- **Every screen** needs empty / loading (skeleton) / error / offline states.
- **Money & timers** use tabular numerals so they don't jitter.
- One consistent brand across mobile (Expo) and web (owner dashboard + super-admin).

## Lessons from the trial (learn, don't copy)
The trial (`D:\K3\Pochinki\.design-src*`, `DESIGN_PROMPT.md`) is worth a look for *what worked operationally*, not for its visuals:
- A glanceable grid of device cards with live timers and clear free/busy/maintenance states reads well at a counter.
- Bottom sheets for start-session / add-order / close-session keep the primary grid in context.
- Segmented controls (billing mode, play mode, payment method), number steppers, and a prepaid countdown ring matched the tasks well.
- An owner-selectable accent color was a nice touch.

Take the *interaction lessons*; design the look fresh with `ui-ux-pro-max` + magic MCP. Enforced by `rtl-i18n-check` (RTL/i18n correctness), not by matching trial tokens.
