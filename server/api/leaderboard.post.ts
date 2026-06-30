import { Redis } from "@upstash/redis";
import {
  LEADERBOARD_SIZE,
  isValidNickname,
  sanitizeNickname,
} from "#shared/leaderboard";

// Same key as the GET endpoint. Members are stored as "nick|id".
const LEADERBOARD_KEY = "wordle:leaderboard";

/**
 * POST /api/leaderboard   body: { nick: string, score: number }
 *
 * Validates the submission and adds it to the sorted set with ZADD. The client
 * already checks these, but client checks are not a security guarantee, so we
 * re-check here. The member is "nick|id" with a random id, so two players with
 * the same nickname remain distinct entries.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  // Score must be a whole, non-negative, sane number.
  const score = Number(body?.score);
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000) {
    throw createError({ statusCode: 400, statusMessage: "Invalid score" });
  }

  // Nickname must survive sanitising with at least one character left.
  if (typeof body?.nick !== "string" || !isValidNickname(body.nick)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid nickname" });
  }
  const nick = sanitizeNickname(body.nick);

  const config = useRuntimeConfig(event);
  const redis = new Redis({
    url: config.upstashRedisRestUrl,
    token: config.upstashRedisRestToken,
  });

  // "|" cannot appear in a sanitised nick, so it is a safe separator.
  const member = `${nick}|${crypto.randomUUID()}`;
  await redis.zadd(LEADERBOARD_KEY, { score, member });

  // Keep the set small: drop everything below the top LEADERBOARD_SIZE.
  // Ranks go low-to-high, so this removes the lowest-scoring extras.
  await redis.zremrangebyrank(LEADERBOARD_KEY, 0, -(LEADERBOARD_SIZE + 1));

  return { ok: true };
});
