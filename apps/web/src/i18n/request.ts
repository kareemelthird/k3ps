import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  // Arabic-first: the only locale for Phase 3.
  // Locale negotiation (en fallback, user preference) is Phase 6+.
  const locale = 'ar';

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
