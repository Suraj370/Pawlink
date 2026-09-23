// A safe, non-secret build identifier — a commit SHA or CI build number,
// never anything derived from a secret. Read from APP_VERSION (see
// env.ts), which a production build pipeline sets explicitly (the
// Dockerfile accepts it as a build arg — see apps/api/Dockerfile); local
// development has no such pipeline, so it simply falls back to "dev".
export function resolveAppVersion(appVersion: string | undefined): string {
  return appVersion ?? "dev";
}
