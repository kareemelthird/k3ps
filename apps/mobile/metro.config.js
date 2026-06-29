/**
 * Metro config — monorepo-aware + Sentry source-map support.
 *
 * getSentryExpoConfig wraps getDefaultConfig and wires source-map generation.
 * Source-map upload only occurs when SENTRY_AUTH_TOKEN is present at build time
 * (ADR-0011 §Q7). When absent (every contributor build / CI) the build still
 * succeeds identically to using plain getDefaultConfig. (AC 11, AC 30-31)
 *
 * NOTE: SENTRY_AUTH_TOKEN must NEVER be committed or placed in eas.json —
 * it would embed in the JS bundle. Keep it as an EAS secret or CI env var.
 */
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

// Sentry-extended config (falls back to getDefaultConfig when auth token absent).
const config = getSentryExpoConfig(projectRoot);

// Watch all files in the monorepo
config.watchFolders = [workspaceRoot];

// Allow Metro to resolve packages from the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Enable symlinks for workspace packages
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
