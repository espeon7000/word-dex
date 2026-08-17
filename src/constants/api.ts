// Empty string when unset - fetch(`${API_BASE_URL}/api/sync`) then just
// resolves to the relative "/api/sync", which is correct for local dev (the
// Metro dev server serves both the JS bundle and the API routes from the
// same origin). A standalone build has no such server, so it needs an
// absolute URL pointing at wherever the API routes actually got deployed
// (EAS Hosting) - set via EXPO_PUBLIC_API_URL at build time in that case.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
