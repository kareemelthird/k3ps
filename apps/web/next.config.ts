import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Transpile the @ps/core workspace package
  transpilePackages: ['@ps/core'],
};

export default withNextIntl(nextConfig);
