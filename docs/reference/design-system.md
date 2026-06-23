# Reference: design system (from Pochinki trial)

Dark, warm-orange gaming identity, Arabic-first RTL, counter-speed. Canonical source: `D:\K3\Pochinki\.design-src3\Pochinki.dc.html` + `src/theme/index.ts` + `src/theme/fonts.ts`. (`.design-src`/`.design-src2` are superseded cyan/purple iterations — orange won.)

## Colors (exact hex, from theme/index.ts)
- **Backgrounds:** bg `#0B0E14` · board `#08090C` · surface `#141923` · surfaceAlt `#1C2330` · surfaceHigh `#252E3F` · surfaceFree `#10141C` · border `#2A3343` · borderSoft `#1C2330`.
- **Brand (orange):** brand `#F7941E` · brandLight `#FF9D2E` · accent `#F7591E` · brandDim `#C2761A`.
- **Status:** free/success `#22C55E` · busy `#F7941E` · maintenance `#64748B` · warning `#F59E0B` · danger `#EF4444` · ps4 badge `#60A5FA`.
- **Text:** primary `#F8FAFC` · muted `#94A3B8` · faint `#5B6675` · warmMuted `#FCD9A8` · onBrand `#1A0E02`.
- **Gradients:** brand `['#FF9D2E','#F7591E']` · busy `['#F7591E','#FF9D2E']` · free `['#16A34A','#22C55E']` · danger `['#DC2626','#EF4444']` · warmStrip `['rgba(247,148,30,.16)','rgba(247,89,30,.08)']`.

## Accent customization (owner setting, `appearance/store.ts`)
Presets: orange `#F7941E` (برتقالي, default) · cyan `#00B0F0` (سماوي) · purple `#7C3AED` (بنفسجي) · green `#22C55E` (أخضر) · pink `#EC4899` (وردي) · red `#EF4444` (أحمر). Icons/CTAs/active states/pills recolor to the selected accent.

## Typography (Cairo, fonts.ts)
Weights: `Cairo_400Regular/500Medium/600SemiBold/700Bold/800ExtraBold/900Black` via `cairo(weight)`. Sizes: xs12 sm14 md16 lg20 xl26 xxl34 display48. Timers & money use **tabular numerals** (`tnum`). Money shows as Arabic-Indic + `ج.م`.

## Spacing / radius / interaction
Spacing: xs4 sm8 md12 lg16 xl24 xxl32. Radius: sm8 md12 lg16 xl24 pill999 · chip11 seg13 input14 card15 sheet26. **TAP_TARGET = 52px min.** Shadows sm(op.25/r6/e3) md(op.35/r12/e8); `glow(color, .5)` for busy cards (e10/r14). Busy card `pochPulse` 2.6s.

## Established flows (match these designs)
- **Device grid:** free card = dashed border `#2A3343`, "اضغط للبدء"; busy card = orange border + pulse, large timer (26px/900), prepaid shows progress bar `['#F7591E','#FF9D2E']` + "متبقّي من N دقيقة", open shows "وقت مفتوح · فردي", total line in orange.
- **Start session sheet:** billing-mode segmented (prepaid/open/fixed), play-mode segmented (single/multi), prepaid block chips (60/120/180/custom), resolved-rate preview card, full-width orange-gradient CTA "بدء الجلسة".
- **Active prepaid:** 212px progress ring (track `#1C2330`, fill `#F7941E`), centered "متبقّي" + big timer, status badge (green→red <10min), itemized costs card, removable orders list, actions تمديد/إضافة طلب/إنهاء(red).
- **Active open:** gradient hero timer (50px/900) + current-rate badge, costs card, **segment timeline** (dot per segment, first orange / next purple `#7C3AED`, mode·rate·duration), single/multi switch, ماتش/add-order/close.
- **Add order sheet:** category chips, 2-col product grid with inline NumberStepper (− on `#252E3F`, + on `#F7941E`), running total footer + orange CTA. Sheet radius 26px top, pull handle, dim overlay.
- **Shift:** gradient sales hero (38px/900) + opening/expected KPIs, 2×2 KPI grid, donut payment breakdown (cash `#22C55E` / wallet `#F7941E` / other `#64748B`), amber close-shift button.
- **Close session sheet:** itemized summary, payment-method segmented (cash/wallet/other; +debt), orange confirm.

## Cross-surface rules
The Next.js owner dashboard + super-admin share this identity (same tokens, RTL, Arabic-Indic). Counter-speed: ≥52px targets, minimal taps, glanceable. Enforced by `rtl-i18n-check`.
