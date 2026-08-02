/**
 * Regole e tipi della classifica, usati SIA dal client (per dare una risposta
 * immediata) SIA dal server (per la rivalidazione di sicurezza), importati con
 * l'alias `#shared`:  import { ... } from '#shared/leaderboard'
 *
 * Tenendo le regole in un unico posto, le due parti non possono divergere.
 */

/** Quante righe mostra e conserva la classifica come "i migliori". */
export const LEADERBOARD_SIZE = 10;

/** Lunghezza massima del nome, in caratteri (non i 3 degli arcade classici). */
export const NICKNAME_MAX_LENGTH = 12;

/** Una riga di classifica, nella forma in cui client e server se la scambiano. */
export interface LeaderboardEntry {
  nick: string;
  score: number;
}

/**
 * Ripulisce un nome grezzo rendendolo sicuro da salvare e da mostrare. Tiene
 * solo una lista di caratteri ammessi (lettere, cifre, spazio e pochi
 * separatori) — il che esclude anche i caratteri di controllo — poi toglie gli
 * spazi ai lati e taglia la lunghezza. Usata da entrambe le parti, così la
 * regola è identica ovunque.
 */
export function sanitizeNickname(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9 ._-]/g, "")
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
}

/** Un nome è valido se, una volta ripulito, resta di almeno un carattere. */
export function isValidNickname(raw: string): boolean {
  return sanitizeNickname(raw).length > 0;
}
