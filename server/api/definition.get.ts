import { getDefinition } from "#shared/definitions";

/**
 * GET /api/definition?word=aisle
 *
 * Restituisce la voce di dizionario di una parola.
 *
 * Il dizionario completo (2.315 voci, ~440 KB) è importato QUI e non nel
 * gioco: il codice dentro `server/` non viene mai spedito al browser. Così il
 * giocatore scarica solo la voce che gli serve — qualche centinaio di byte —
 * invece di mezzo megabyte di parole che non vedrà mai.
 *
 * Non serve gestire il caso "parola inesistente": getDefinition restituisce
 * comunque un oggetto valido (il ripiego), quindi questo endpoint non può
 * fallire né restituire nulla.
 */
export default defineEventHandler((event) => {
  const word = String(getQuery(event).word);
  return getDefinition(word);
});
