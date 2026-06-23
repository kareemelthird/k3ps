---
name: rtl-i18n-check
description: Verify Arabic-first RTL correctness and i18n string coverage in UI code (apps/mobile, apps/web). Use after building or changing any screen/component. Catches hardcoded user-facing strings, non-mirrored layouts, and Latin-numeral money displays.
allowed-tools: Read, Grep, Glob, Bash
---

# rtl-i18n-check

The product is Arabic-first and RTL. UI that hardcodes English or doesn't mirror is a defect.

## Checks
1. **No hardcoded user-facing strings.** Every visible string comes from the i18n resource (e.g. `t('...')`). Grep changed UI files for string literals inside JSX/Text and flag any that aren't keys, icons, or test ids.
2. **RTL layout.** Layouts mirror correctly: directional padding/margins use start/end (not hardcoded left/right), chevrons/arrows point the RTL direction, lists/progress fill from the right. Flag `marginLeft`/`paddingRight`-style hardcoding in directional contexts.
3. **Numerals.** Money and counts that the trial showed as Arabic-Indic use the shared digit helper, not raw Latin digits.
4. **No clipped Arabic.** Text containers allow Arabic ascenders/diacritics; no fixed heights that clip.
5. **Key coverage.** Every new i18n key used in code exists in the Arabic resource file; no missing-key fallbacks shipping to users.

## How to run
- `grep`/Grep the changed files under `apps/` for: JSX text literals, `marginLeft|marginRight|paddingLeft|paddingRight|left:|right:`, and raw money formatting.
- Confirm new `t('key')` references resolve in the i18n resources.

## Output
A list of findings (file:line → issue → fix) grouped by check, plus a PASS/FAIL. Empty findings = PASS.
