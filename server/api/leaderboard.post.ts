import { Redis } from "@upstash/redis";
import {
  LEADERBOARD_SIZE,
  isValidNickname,
  sanitizeNickname,
} from "#shared/leaderboard";

// Stessa chiave usata dalla GET. Ogni membro è salvato come "nick|id".
const LEADERBOARD_KEY = "wordle:leaderboard";

/**
 * POST /api/leaderboard   body: { nick: string, score: number }
 *
 * Valida l'invio e lo aggiunge all'insieme ordinato con ZADD. Il client fa già
 * questi controlli, ma un controllo lato client non è una garanzia di sicurezza
 * (chiunque può chiamare l'API a mano), quindi qui si ricontrolla tutto. Il
 * membro è "nick|id" con un id casuale, così due giocatori con lo stesso nome
 * restano righe distinte.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  // Il punteggio dev'essere un numero intero, non negativo e plausibile.
  const score = Number(body?.score);
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000) {
    throw createError({ statusCode: 400, statusMessage: "Invalid score" });
  }

  // Il nome deve sopravvivere alla pulizia con almeno un carattere.
  if (typeof body?.nick !== "string" || !isValidNickname(body.nick)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid nickname" });
  }
  const nick = sanitizeNickname(body.nick);

  const config = useRuntimeConfig(event);
  const redis = new Redis({
    url: config.upstashRedisRestUrl,
    token: config.upstashRedisRestToken,
  });

  // "|" non può comparire in un nome ripulito, quindi è un separatore sicuro.
  const member = `${nick}|${crypto.randomUUID()}`;
  await redis.zadd(LEADERBOARD_KEY, { score, member });

  // Tiene l'insieme piccolo: butta via tutto ciò che sta sotto i primi
  // LEADERBOARD_SIZE. Le posizioni vanno dal punteggio più basso al più alto,
  // quindi questa riga elimina proprio gli eccedenti peggiori.
  await redis.zremrangebyrank(LEADERBOARD_KEY, 0, -(LEADERBOARD_SIZE + 1));

  return { ok: true };
});
