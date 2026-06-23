---
name: rtl-i18n-check
description: Verify Arabic-first RTL correctness and i18n string coverage in UI code (apps/mobile, apps/web). Use after building or changing any screen/component. Catches hardcoded user-facing strings, non-mirrored layouts, and Latin-numeral money displays.
allowed-tools: Read, Grep, Glob, Bash
---

# rtl-i18n-check

The product is Arabic-first and RTL. UI that hardcodes English or doesn't mirror is a defect. Reference: `docs/reference/mobile-patterns.md` (i18n/RTL) and the ux-designer's generated `docs/design/design-system.md`.

## Checks
1. **No hardcoded user-facing strings.** Every visible string comes from i18n (`t('...')`). Sweep changed UI files for JSX/`<Text>`/`<AppText>` string literals that aren't keys, icon names, or testIDs:
   ```
   # candidate offenders (review hits by hand — not all are bugs)
   grep -rnE ">[^<{]*[A-Za-z؀-ۿ]{2,}[^<}]*<" apps/*/ --include=*.tsx
   ```
2. **RTL layout.** Directional spacing uses start/end, not hardcoded left/right; rows use `row-reverse`; chevrons/progress fill RTL.
   ```
   grep -rnE "marginLeft|marginRight|paddingLeft|paddingRight|left:|right:|textAlign: '(left|right)'" apps/*/ --include=*.tsx
   ```
3. **Numerals.** Displayed money/counts use `toArabicDigits`/`formatEgp`, not raw Latin digits in user-facing text.
4. **No clipped Arabic.** No fixed heights on text containers that would clip Arabic ascenders/diacritics.
5. **Key coverage.** Every `t('key')` used resolves in the Arabic resource (`ar.json`); no missing-key fallbacks shipping to users. Cross-check used keys against the resource file.

## How to run
- Run the greps above over the changed files; review each hit (some left/right uses are non-directional and fine — judge in context).
- Confirm new `t('key')` references exist in `ar.json`.

## Output
Findings grouped by check: `file:line → issue → fix`. Empty findings = **PASS**. This complements `ps-verify`; both must be clean before review.
