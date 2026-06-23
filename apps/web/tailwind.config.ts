import type { Config } from 'tailwindcss';

/**
 * Tailwind config — implements the "Calm Operations" design system tokens.
 * Source of truth: docs/design/design-system.md §2–§4.
 * Dark-first (dark is the default surface for the operator app).
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // ── Color tokens (design-system.md §2.2) ──────────────────────────────
      colors: {
        // Primitive ramps (reference only — semantic tokens below)
        neutral: {
          0: '#F8FAFC',
          50: '#EEF2F6',
          100: '#E2E8F0',
          200: '#CBD5E1',
          300: '#94A3B8',
          400: '#64748B',
          500: '#475569',
          600: '#334155',
          700: '#1E293B',
          800: '#131A26',
          900: '#0D131D',
          950: '#080C13',
        },
        teal: {
          300: '#5EEAD4',
          400: '#2DD4BF',
          500: '#14B8A6',
          600: '#0D9488',
          700: '#0F766E',
        },
        // Semantic tokens mapped to CSS variables for both dark/light
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        'surface-2': 'var(--color-surface-2)',
        'surface-3': 'var(--color-surface-3)',
        border: 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        'text-faint': 'var(--color-text-faint)',
        primary: 'var(--color-primary)',
        'primary-press': 'var(--color-primary-press)',
        'on-primary': 'var(--color-on-primary)',
        'status-free': '#10B981',
        'status-busy': '#3B82F6',
        'status-maint': '#64748B',
        warning: '#F59E0B',
        danger: '#EF4444',
        info: '#3B82F6',
      },
      // ── Typography scale (design-system.md §3.1) ─────────────────────────
      fontFamily: {
        sans: ['IBM Plex Sans Arabic', 'IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      fontSize: {
        'display': ['34px', { lineHeight: '40px', fontWeight: '800' }],
        'h1': ['26px', { lineHeight: '32px', fontWeight: '700' }],
        'h2': ['20px', { lineHeight: '28px', fontWeight: '700' }],
        'h3': ['17px', { lineHeight: '24px', fontWeight: '600' }],
        'body': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'label': ['14px', { lineHeight: '20px', fontWeight: '500' }],
        'caption': ['13px', { lineHeight: '18px', fontWeight: '500' }],
        'micro': ['12px', { lineHeight: '16px', fontWeight: '600' }],
        'timer': ['28px', { lineHeight: '32px', fontWeight: '600' }],
        'money': ['16px', { lineHeight: '24px', fontWeight: '700' }],
      },
      // ── Spacing scale (design-system.md §4) ──────────────────────────────
      spacing: {
        '2xs': '4px',
        'xs': '8px',
        'sm': '12px',
        'md': '16px',
        'lg': '20px',
        'xl': '24px',
        '2xl': '32px',
        '3xl': '48px',
      },
      // ── Border radius (design-system.md §4) ──────────────────────────────
      borderRadius: {
        'xs': '8px',
        'sm': '10px',
        'md': '14px',
        'lg': '20px',
        'pill': '999px',
      },
      // ── Box shadow / elevation (design-system.md §4) ─────────────────────
      boxShadow: {
        'e0': 'none',
        'e1': '0 2px 8px rgba(0,0,0,0.30)',
        'e2': '0 6px 16px rgba(0,0,0,0.40)',
        'e3': '0 12px 28px rgba(0,0,0,0.50)',
      },
      // ── Motion tokens (design-system.md §5) ──────────────────────────────
      transitionDuration: {
        'fast': '150ms',
        'base': '220ms',
        'slow': '320ms',
      },
      transitionTimingFunction: {
        'enter': 'cubic-bezier(0.16,1,0.3,1)',
        'exit': 'cubic-bezier(0.4,0,1,1)',
      },
      // ── Grid gutters ──────────────────────────────────────────────────────
      gap: {
        'card': '12px',
      },
    },
  },
  plugins: [],
};

export default config;
