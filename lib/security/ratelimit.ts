import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "@/lib/config";

type Window = Parameters<typeof Ratelimit.slidingWindow>[1];

let redis: Redis | null | undefined;
const limiters = new Map<string, Ratelimit>();

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;

  const cfg = env();
  if (!cfg.UPSTASH_REDIS_REST_URL || !cfg.UPSTASH_REDIS_REST_TOKEN) {
    if (process.env.NODE_ENV === "production") {
      // fail-closed: sem rate limit não subimos para produção
      throw new Error("Rate limit não configurado: defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.");
    }
    redis = null;
    return null;
  }

  redis = new Redis({ url: cfg.UPSTASH_REDIS_REST_URL, token: cfg.UPSTASH_REDIS_REST_TOKEN });
  return redis;
}

/**
 * Retorna true se a ação ainda está dentro do limite.
 * Ex.: enforceRateLimit("swap-user", userId, 10, "1 m")
 */
export async function enforceRateLimit(name: string, identifier: string, max: number, window: Window): Promise<boolean> {
  const client = getRedis();
  if (!client) return true; // só em desenvolvimento local sem Redis

  const cacheKey = `${name}:${max}:${window}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(max, window),
      prefix: `swapai:rl:${name}`,
      analytics: false,
    });
    limiters.set(cacheKey, limiter);
  }

  const { success } = await limiter.limit(identifier);
  return success;
}
