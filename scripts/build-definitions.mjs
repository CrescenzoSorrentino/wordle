// Assembla i blocchi di definizioni in shared/words/definitions.ts,
// verificando la copertura rispetto alla lista delle parole-soluzione.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(here, "..");
const CHUNKS = join(here, ".cache", "chunks");
const OUT = join(PROJECT, "shared/words/definitions.ts");

if (!existsSync(CHUNKS)) mkdirSync(CHUNKS, { recursive: true });

const words = readFileSync(join(here, ".cache", "words.txt"), "utf8").trim().split("\n");
const wordSet = new Set(words);

// Unisce tutti i blocchi, segnalando le parole definite due volte.
const defs = {};
const duplicates = [];
for (const file of readdirSync(CHUNKS).filter((f) => f.endsWith(".json")).sort()) {
  const chunk = JSON.parse(readFileSync(join(CHUNKS, file), "utf8"));
  for (const [word, def] of Object.entries(chunk)) {
    if (defs[word]) duplicates.push(`${word} (anche in ${file})`);
    defs[word] = def;
  }
}

// === Verifiche ===
const problems = [];
const extra = Object.keys(defs).filter((w) => !wordSet.has(w));
const missing = words.filter((w) => !defs[w]);

const POS = [
  "noun", "verb", "adjective", "adverb",
  "preposition", "conjunction", "pronoun", "interjection", "determiner",
];
const LEVELS = ["common", "uncommon", "rare"];

for (const [word, def] of Object.entries(defs)) {
  if (typeof def?.pos !== "string" || !def.pos.trim())
    problems.push(`${word}: categoria grammaticale mancante`);
  else
    for (const p of def.pos.split(" · "))
      if (!POS.includes(p)) problems.push(`${word}: categoria "${p}" non riconosciuta`);
  // L'IPA va fra barre, come in ogni dizionario.
  if (typeof def?.ipa !== "string" || !/^\/.+\/$/.test(def.ipa))
    problems.push(`${word}: IPA mancante o non racchiuso fra barre`);
  if (!LEVELS.includes(def?.level))
    problems.push(`${word}: livello "${def?.level}" non riconosciuto`);
  if (typeof def?.en !== "string" || def.en.trim().length < 10)
    problems.push(`${word}: definizione mancante o troppo corta`);
  if (typeof def?.example !== "string" || def.example.trim().length < 10)
    problems.push(`${word}: frase d'esempio mancante o troppo corta`);
  // La frase dovrebbe contenere la parola (anche coniugata: si controlla la
  // radice di 4 lettere, così "lifting" vale per "lift").
  //
  // ATTENZIONE: questo controllo dà falsi allarmi sui verbi irregolari, che al
  // passato cambiano la vocale interna — "clung" non contiene "clin", eppure la
  // frase è giusta. Le segnalazioni qui sotto vanno guardate a occhio, non
  // corrette a scatola chiusa.
  else if (!def.example.toLowerCase().includes(word.slice(0, 4)))
    problems.push(`${word}: la frase forse non contiene la parola — CONTROLLARE`);
  if (def?.it) problems.push(`${word}: campo "it" residuo, va tolto`);
}

console.log(`Definite:  ${Object.keys(defs).length} / ${words.length}`);
console.log(`Mancanti:  ${missing.length}`);
if (extra.length) console.log(`⚠️  Estranee: ${extra.join(", ")}`);
if (duplicates.length) console.log(`⚠️  Duplicate: ${duplicates.join(", ")}`);
if (problems.length) console.log(`⚠️  Problemi:\n  ${problems.join("\n  ")}`);
if (missing.length) console.log(`Prossime da fare: ${missing.slice(0, 5).join(", ")}…`);

// === Scrittura del file, in ordine alfabetico come la lista di partenza ===
const body = words
  .filter((w) => defs[w])
  .map((w) => {
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const d = defs[w];
    return (
      `  ${w}: {\n` +
      `    pos: "${esc(d.pos)}",\n` +
      `    ipa: "${esc(d.ipa)}",\n` +
      `    level: "${esc(d.level)}",\n` +
      `    en: "${esc(d.en)}",\n` +
      `    example: "${esc(d.example)}",\n` +
      `  },`
    );
  })
  .join("\n");

writeFileSync(
  OUT,
  `/**
 * Voce di dizionario per ogni parola-soluzione, mostrata fra un livello e
 * l'altro. La chiave è la parola stessa, così la ricerca è immediata (stesso
 * ragionamento di VALID_WORD_SET in shared/wordle.ts).
 *
 * Tutti i testi sono in inglese di proposito: il gioco è per chiunque impari
 * l'inglese, non solo per chi parla italiano. (I commenti del codice restano
 * italiani: quelli servono a chi sviluppa, non a chi gioca.)
 *
 * File di dati generato — non modificare a mano.
 */

/** Quello che il gioco mostra per una parola, in stile dizionario. */
export interface WordDefinition {
  /** Part of speech: "noun", "verb", … Several joined by " · ". */
  pos: string;
  /** Pronunciation in IPA, between slashes: "/aɪl/". */
  ipa: string;
  /** How worth learning the word is: "common", "uncommon" or "rare". */
  level: string;
  /** Short dictionary-style definition, in simple English. */
  en: string;
  /** A sentence using the word, to show it in context. */
  example: string;
}

export const DEFINITIONS: Record<string, WordDefinition> = {
${body}
};
`,
);

console.log(`\n✔ Scritto ${OUT}`);
