import { Redis } from "@upstash/redis";
import { LEADERBOARD_SIZE, type LeaderboardEntry } from "#shared/leaderboard";

/**
 * GET /api/leaderboard
 *
 * Restituisce i punteggi migliori, dal più alto. Li legge dall'insieme ordinato
 * di Redis con ZRANGE (rev = dal più alto, withScores = includi il punteggio).
 * Se Redis non risponde non solleva un errore: restituisce una lista vuota, così
 * il gioco continua a funzionare anche senza classifica.
 */
export default defineEventHandler(async (event): Promise<LeaderboardEntry[]> => {
  const config = useRuntimeConfig(event);

  try {
    const redis = new Redis({
      url: config.upstashRedisRestUrl,
      token: config.upstashRedisRestToken,
    });

    // Redis risponde con un array piatto: [membro, punteggio, membro, ...].
    const raw = await redis.zrange<(string | number)[]>(
      currentLeaderboardKey(),
      0,
      LEADERBOARD_SIZE - 1,
      { rev: true, withScores: true },
    );

    // Lo si percorre a due a due, trasformando ogni coppia in una riga.
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
