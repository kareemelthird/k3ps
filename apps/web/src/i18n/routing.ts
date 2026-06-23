/**
 * next-intl routing configuration.
 * Arabic (ar) is the default locale; English (en) is the secondary.
 * All user-facing strings go through i18n — no hardcoded text.
 */
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
});
