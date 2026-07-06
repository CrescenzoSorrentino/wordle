/**
 * Core Wordle rules and game logic (no UI, no Vue, no DOM).
 * Single source of truth for HOW the game works, imported via the
 * `#shared` alias:  import { ... } from '#shared/wordle'
 */
import { VALID_WORDS } from "#shared/words/valid-words";
import { ANSWER_WORDS } from "#shared/words/answer-words";

/** Number of letters in a word (classic Wordle: 5). */
export const WORD_LENGTH = 5;

/** Number of guesses the player gets per word (classic Wordle: 6). */
export const MAX_ATTEMPTS = 6;

/** Timer settings for the arcade levels (see timeForLevel). */
export const START_TIME = 300; // seconds at level 1
export const FLOOR_TIME = 20; // never go below this many seconds
export const DECAY_RATE = 0.92; // per-level shrink factor (smaller = harsher)

// Cap on carried-over time. Same as the start time for now, but named on its
// own so the two can diverge later without touching the rest of the code.
export const MAX_TIME = START_TIME;

// Time rewarded per letter of a submitted guess, to keep good guesses alive.
export const TIME_BONUS_CORRECT = 15; // seconds per green letter
export const TIME_BONUS_PRESENT = 5; // seconds per yellow letter

/**
 * The result for a single letter of a guess:
 * - "correct": right letter, right position (green)
 * - "present": letter is in the word but in another position (yellow)
 * - "absent":  letter is not in the word (grey)
 */
export type LetterState = "correct" | "present" | "absent";

/**
 * Lookup set for guess validation. Built once from the array so "is this a real
 * word?" is instant, instead of scanning ~15k words on every guess.
 */
const VALID_WORD_SET = new Set(VALID_WORDS);

/**
 * Returns true if `word` is accepted as a guess (exists in the allowed list).
 * Trimmed and lower-cased first so casing never causes a false reject.
 */
export function isValidWord(word: string): boolean {
  return VALID_WORD_SET.has(word.trim().toLowerCase());
}

/**
 * Picks a random solution from the answer list. Math.random is fine here: the
 * choice just needs to be unpredictable to the player, not cryptographically
 * secure.
 */
export function pickRandomAnswer(): string {
  const index = Math.floor(Math.random() * ANSWER_WORDS.length);
  return ANSWER_WORDS[index]!;
}

/**
 * Compares a guess against the answer and returns one LetterState per letter.
 *
 * Duplicate letters are handled in two passes so a letter is never highlighted
 * more times than it actually occurs:
 *   Pass 1 (greens): mark exact-position matches and spend them from a tally
 *                    of the answer's remaining letters.
 *   Pass 2 (yellows): mark a not-yet-green letter "present" only if the tally
 *                     still has one to spend; otherwise it stays "absent".
 *
 * Both inputs are assumed same-length and lower-cased (call isValidWord first).
 */
export function evaluateGuess(guess: string, answer: string): LetterState[] {
  const result: LetterState[] = new Array(guess.length).fill("absent");

  // How many of each letter are still available to match (answer's letters
  // minus the ones already claimed by a green).
  const remaining: Record<string, number> = {};
  for (const letter of answer) {
    remaining[letter] = (remaining[letter] ?? 0) + 1;
  }

  // Pass 1: greens.
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === answer[i]) {
      result[i] = "correct";
      remaining[guess[i]!]!--;
    }
  }

  // Pass 2: yellows / greys.
  for (let i = 0; i < guess.length; i++) {
    if (result[i] === "correct") {
      continue;
    }
    const letter = guess[i]!;
    if ((remaining[letter] ?? 0) > 0) {
      result[i] = "present";
      remaining[letter]!--;
    }
  }

  return result;
}

/**
 * Seconds available at a given level. Decays exponentially toward FLOOR_TIME:
 * time = floor + (start - floor) * rate^(level - 1)
 */
export function timeForLevel(level: number): number {
  return Math.floor(
    FLOOR_TIME + (START_TIME - FLOOR_TIME) * Math.pow(DECAY_RATE, level - 1),
  );
}
