import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Transpile the workspace package so Next.js processes its TypeScript
  transpilePackages: ['@ps/core'],
};

export default withNextIntl(nextConfig);
