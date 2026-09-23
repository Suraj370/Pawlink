import Redis from "ioredis";

// null when REDIS_URL isn't configured — rate limiting (the only
// consumer of this client) treats that as "disabled," not an error. See
// env.ts's comment on REDIS_URL and middleware/rateLimit.ts.
export function createRedisClient(redisUrl: string | undefined): Redis | null {
  if (!redisUrl) return null;
  return new Redis(redisUrl, {
    // Rate limiting must never take the whole API down if Redis is
    // temporarily unreachable — a slow/failed Redis call should fail
    // open (allow the request) rather than block real traffic. Capping
    // retries and using lazyConnect keeps a misbehaving Redis from
    // piling up reconnect attempts or blocking process startup.
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
}
