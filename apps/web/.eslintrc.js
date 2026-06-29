// apps/web/.eslintrc.js
// ESLint configuration for the Next.js web app.
// Uses next/core-web-vitals + jsx-a11y/recommended (ADR-0011 §Q5).
// Run via: npm --workspace apps/web run lint
/** @type {import('eslint').Linter.Config} */
module.exports = {
  extends: [
    'next/core-web-vitals',
    'plugin:jsx-a11y/recommended',
  ],
  plugins: ['jsx-a11y'],
  rules: {
    // Dialogs (role="dialog") with onClick are valid interactive elements.
    // The outer dialog container handles backdrop clicks — jsx-a11y accepts this
    // on interactive roles. No override needed here; kept for documentation.
  },
};
