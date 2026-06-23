/**
 * i18n — Arabic-first, RTL.
 * All user-facing strings are keys resolved here; no hardcoded strings anywhere.
 * RTL is forced once at boot (in app/_layout.tsx); see mobile-patterns.md.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import ar from './ar.json';

i18next.use(initReactI18next).init({
  compatibilityJSON: 'v4',
  lng: 'ar',
  fallbackLng: 'ar',
  resources: {
    ar: { translation: ar },
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18next;
export { ar };
