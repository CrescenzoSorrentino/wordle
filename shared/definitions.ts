/**
 * Come si legge la spiegazione di una parola, importato con l'alias `#shared`:
 *   import { getDefinition } from '#shared/definitions'
 *
 * I testi veri stanno in `#shared/words/definitions`, che è un file di dati
 * generato: qui sta solo la logica scritta a mano, così una rigenerazione dei
 * dati non la cancella.
 */
import { type WordDefinition, DEFINITIONS } from "#shared/words/definitions";

/**
 * Testo mostrato quando una parola non ha spiegazione (una generazione fallita,
 * una parola saltata). Sta in una costante a parte, e non dentro la funzione,
 * per poterlo cambiare o riusare senza toccare la logica.
 */
export const MISSING_DEFINITION: WordDefinition = {
  // Di una parola non ancora generata non sappiamo nulla: né la categoria
  // grammaticale, né la pronuncia, né una frase d'esempio. Quei campi restano
  // quindi vuoti e il template salta le righe vuote — meglio una finestra
  // sobria che quattro righe di scuse. Il testo è in inglese come tutto il
  // resto di ciò che vede il giocatore.
  pos: "",
  ipa: "",
  level: "",
  en: "No definition available for this word yet.",
  example: "",
};

/**
 * Restituisce la spiegazione di `word`, o MISSING_DEFINITION se non c'è.
 *
 * Non restituisce mai `undefined` e non lancia errori: una spiegazione mancante
 * è un difetto estetico, e non deve interrompere una partita in corso.
 *
 * L'ingresso viene normalizzato (spazi tolti, tutto minuscolo) perché le chiavi
 * di DEFINITIONS sono minuscole: senza, cercare "LEMON" darebbe il ripiego
 * anche se la parola c'è.
 */
export function getDefinition(word: string): WordDefinition {
  return DEFINITIONS[word.trim().toLowerCase()] ?? MISSING_DEFINITION;
}
