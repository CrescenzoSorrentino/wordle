import { Redis } from "@upstash/redis";
import { LEADERBOARD_SIZE, type LeaderboardEntry } from "#shared/leaderboard";

// The Redis key under which the sorted set lives. Members are stored as
// "nick|id" so two players with the same nickname stay distinct.
const LEADERBOARD_KEY = "wordle:leaderboard";

/**
 * GET /api/leaderboard
 *
 * Returns the top scores, highest first. Reads them from the Redis sorted set
 * with ZRANGE (rev = highest first, withScores = include each score). If Redis
 * is unreachable we fail soft and return an empty list, so the game UI still
 * works without a leaderboard.
 */
export default defineEventHandler(async (event): Promise<LeaderboardEntry[]> => {
  const config = useRuntimeConfig(event);

  try {
    const redis = new Redis({
      url: config.upstashRedisRestUrl,
      token: config.upstashRedisRestToken,
    });

    // Flat array: [member, score, member, score, ...].
    const raw = await redis.zrange<(string | number)[]>(
      LEADERBOARD_KEY,
      0,
      LEADERBOARD_SIZE - 1,
      { rev: true, withScores: true },
    );

    // Walk the flat array two at a time, turning each pair into an entry.
    const entries: LeaderboardEntry[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const member = String(raw[i]);
      const score = Number(raw[i + 1]);
      const nick = member.split("|")[0] ?? "???";
      entries.push({ nick, score });
    }
    return entries;
  } catch (e) {
    console.error("Leaderboard read failed (returning empty):", e);
    return [];
  }
});
