/**
 * Regole e logica di gioco di Wordle (niente interfaccia, niente Vue, niente
 * DOM). Unica fonte di verità su COME funziona il gioco, importata con l'alias
 * `#shared`:  import { ... } from '#shared/wordle'
 */
import { VALID_WORDS } from "#shared/words/valid-words";
import { ANSWER_WORDS } from "#shared/words/answer-words";

/** Numero di lettere di una parola (Wordle classico: 5). */
export const WORD_LENGTH = 5;

/** Tentativi a disposizione per ogni parola (Wordle classico: 6). */
export const MAX_ATTEMPTS = 6;

/** Impostazioni del timer per i livelli arcade (vedi timeForLevel). */
export const START_TIME = 300; // secondi al livello 1
export const FLOOR_TIME = 30; // non si scende mai sotto questi secondi
export const DECAY_RATE = 0.92; // quanto si accorcia per livello (più basso = più duro)

// Tetto massimo al tempo riportato da un livello all'altro. Per ora coincide
// col tempo iniziale, ma ha un nome suo così i due valori potranno divergere
// senza toccare il resto del codice.
export const MAX_TIME = START_TIME;

// Tempo regalato per ogni lettera di un tentativo, per premiare chi indovina.
export const TIME_BONUS_CORRECT = 10; // secondi per lettera verde
export const TIME_BONUS_PRESENT = 5; // secondi per lettera gialla

// Tempo perso per un tentativo che non rivela nulla di nuovo (sprecato).
export const TIME_PENALTY = 5; // secondi

export const EXPLANATION_TIME = 12; // secondi per leggere la spiegazione di una parola

/**
 * L'esito di una singola lettera di un tentativo:
 * - "correct": lettera giusta al posto giusto (verde)
 * - "present": la lettera c'è, ma in un'altra posizione (giallo)
 * - "absent":  la lettera non è nella parola (grigio)
 */
export type LetterState = "correct" | "present" | "absent";

/**
 * Insieme di ricerca per validare i tentativi. Costruito una volta sola
 * dall'array, così la domanda "è una parola vera?" ha risposta immediata invece
 * di scorrere ~15.000 parole a ogni tentativo.
 */
const VALID_WORD_SET = new Set(VALID_WORDS);

/**
 * Restituisce true se `word` è accettata come tentativo (cioè è nella lista
 * ammessa). Prima toglie gli spazi ai lati e porta tutto in minuscolo, così le
 * maiuscole non provocano mai un rifiuto sbagliato.
 */
export function isValidWord(word: string): boolean {
  return VALID_WORD_SET.has(word.trim().toLowerCase());
}

/**
 * Sceglie una soluzione a caso dalla lista delle risposte. Math.random va
 * benissimo qui: la scelta deve solo essere imprevedibile per il giocatore, non
 * sicura dal punto di vista crittografico.
 */
export function pickRandomAnswer(): string {
  const index = Math.floor(Math.random() * ANSWER_WORDS.length);
  return ANSWER_WORDS[index]!;
}

/**
 * Confronta un tentativo con la soluzione e restituisce un LetterState per ogni
 * lettera.
 *
 * Le lettere ripetute sono gestite in due passaggi, così una lettera non viene
 * mai evidenziata più volte di quante compaia davvero:
 *   Passaggio 1 (verdi): segna le corrispondenze esatte di posizione e le
 *                        scala da un conteggio delle lettere della soluzione.
 *   Passaggio 2 (gialli): segna "present" una lettera non ancora verde solo se
 *                         il conteggio ne ha ancora una da spendere; altrimenti
 *                         resta "absent".
 *
 * Si dà per scontato che i due ingressi siano lunghi uguali e in minuscolo
 * (chiamare prima isValidWord).
 */
export function evaluateGuess(guess: string, answer: string): LetterState[] {
  const result: LetterState[] = new Array(guess.length).fill("absent");

  // Quante copie di ogni lettera sono ancora disponibili (le lettere della
  // soluzione meno quelle già prese da un verde).
  const remaining: Record<string, number> = {};
  for (const letter of answer) {
    remaining[letter] = (remaining[letter] ?? 0) + 1;
  }

  // Passaggio 1: i verdi.
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === answer[i]) {
      result[i] = "correct";
      remaining[guess[i]!]!--;
    }
  }

  // Passaggio 2: gialli e grigi.
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
 * Secondi disponibili a un dato livello. Calano in modo esponenziale verso
 * FLOOR_TIME, senza mai raggiungerlo:
 * tempo = pavimento + (partenza - pavimento) * fattore^(livello - 1)
 */
export function timeForLevel(level: number): number {
  return Math.floor(
    FLOOR_TIME + (START_TIME - FLOOR_TIME) * Math.pow(DECAY_RATE, level - 1),
  );
}
