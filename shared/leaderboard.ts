/**
 * Shared rules and types for the leaderboard, imported by BOTH the client
 * (for instant feedback) and the server (for the security re-validation), via
 * the `#shared` alias:  import { ... } from '#shared/leaderboard'
 *
 * Keeping the rules here means the two sides can never drift out of sync.
 */

/** How many entries the leaderboard shows / keeps as "the top". */
export const LEADERBOARD_SIZE = 10;

/** Maximum nickname length, in characters (not the 3 of classic arcades). */
export const NICKNAME_MAX_LENGTH = 12;

/** One row of the leaderboard as the client and server exchange it. */
export interface LeaderboardEntry {
  nick: string;
  score: number;
}

/**
 * Cleans a raw nickname into something safe to store and display. Keeps only an
 * allow-list of characters (letters, digits, space and a few separators) which
 * also rules out control characters, then trims and caps the length. Used on
 * both sides so the rule is identical everywhere.
 */
export function sanitizeNickname(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9 ._-]/g, "")
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
}

/** A nickname is valid if, once cleaned, it still has at least one character. */
export function isValidNickname(raw: string): boolean {
  return sanitizeNickname(raw).length > 0;
}
