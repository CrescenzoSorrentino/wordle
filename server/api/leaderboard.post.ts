import { Redis } from "@upstash/redis";
import {
  LEADERBOARD_SIZE,
  isValidNickname,
  sanitizeNickname,
  MAX_PLAUSIBLE_SCORE,
} from "#shared/leaderboard";


// Quanti punteggi può mandare uno stesso indirizzo in un'ora, e quanto dura la
// finestra. Restano qui e non in #shared/leaderboard perché non sono regole del
// gioco: al browser non serve saperle, e dirgliele significherebbe solo dire a
// chi bara quanto può osare.
//
// Cinque è largo per un umano — una partita dura un quarto d'ora, e il punteggio
// si manda solo entrando in classifica — e stretto per uno script. Sotto i dieci
// di proposito: i posti in classifica sono dieci, e un limite di dieci all'ora
// lascerebbe occupare da solo l'intera lista.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const LEADERBOARD_EXPIRE_SECONDS = 60 * 60 * 24 * 90;

/**
 * POST /api/leaderboard   body: { nick: string, score: number }
 *
 * Valida l'invio e lo aggiunge all'insieme ordinato con ZADD. Il client fa già
 * questi controlli, ma un controllo lato client non è una garanzia di sicurezza
 * (chiunque può chiamare l'API a mano), quindi qui si ricontrolla tutto. Il
 * membro è "nick|id" con un id casuale, così due giocatori con lo stesso nome
 * restano righe distinte.
 *
 * L'ordine dei controlli non è casuale: prima quelli gratuiti sul corpo della
 * richiesta, che respingono le chiamate malfatte senza nemmeno disturbare
 * Redis, poi il limite di invii, che costa una chiamata di rete. E tutti prima
 * dello ZADD, perché una scrittura fatta non si disfa.
 */
export default defineEventHandler(async (event) => {
  const leaderboardKey = currentLeaderboardKey();
  const body = await readBody(event);

  // Il punteggio dev'essere un numero intero, non negativo e plausibile.
  const score = Number(body?.score);
  if (!Number.isInteger(score) || score < 0 || score > MAX_PLAUSIBLE_SCORE) {
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

  // Da quale indirizzo arriva la richiesta. In produzione la connessione la apre
  // Vercel, non il giocatore, quindi guardare chi si è collegato darebbe lo
  // stesso indirizzo per tutto il mondo: xForwardedFor dice di leggere invece
  // l'intestazione in cui i proxy scrivono il mittente originale.
  //
  // Chi non è identificabile finisce tutto in un secchio comune invece di essere
  // bloccato o lasciato passare. Bloccare sembra prudente ma è la scelta
  // peggiore: se un domani quell'intestazione cambiasse, la classifica
  // smetterebbe di accettare punteggi da chiunque, in silenzio. Così invece il
  // servizio peggiora senza rompersi.
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";

  // Un contatore per indirizzo, che si cancella da solo a fine finestra. I due
  // punti sono la convenzione con cui si raggruppano le chiavi in Redis.
  const rateLimitKey = `wordle:ratelimit:${ip}`;

  // incr e non "leggi, aggiungi uno, riscrivi": incr è atomico, quindi due
  // richieste simultanee non possono leggere lo stesso valore e passare
  // entrambe. È il tipo di errore che si manifesta solo sotto carico, cioè
  // esattamente durante un attacco.
  const submissions = await redis.incr(rateLimitKey);

  // La scadenza si mette solo al primo invio: rinnovandola a ogni richiesta,
  // l'ora ripartirebbe da capo ogni volta e la finestra non si chiuderebbe mai.
  // E va messa PRIMA di qualunque uscita: una chiave senza scadenza è un
  // contatore che non si azzera più, cioè un blocco a vita per quell'indirizzo.
  if (submissions === 1) {
    await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SECONDS);
  }

  // Il rifiuto sta prima dello ZADD, non dopo: dopo, il punteggio sarebbe già
  // in classifica e l'errore sarebbe teatro — un throw non annulla una scrittura
  // già partita verso Redis.
  if (submissions > RATE_LIMIT_MAX) {
    throw createError({
      statusCode: 429,
      statusMessage: "Too many submissions",
    });
  }

  // "|" non può comparire in un nome ripulito, quindi è un separatore sicuro.
  const member = `${nick}|${crypto.randomUUID()}`;
  await redis.zadd(leaderboardKey, { score, member });

  // Tiene l'insieme piccolo: butta via tutto ciò che sta sotto i primi
  // LEADERBOARD_SIZE. Le posizioni vanno dal punteggio più basso al più alto,
  // quindi questa riga elimina proprio gli eccedenti peggiori.
  await redis.zremrangebyrank(leaderboardKey, 0, -(LEADERBOARD_SIZE + 1));
  await redis.expire(leaderboardKey, LEADERBOARD_EXPIRE_SECONDS);

  return { ok: true };
});
