/**
 * Genera le voci di dizionario mancanti chiedendole a Claude, e le salva come
 * blocchi JSON in scripts/.cache/chunks/. Poi build-definitions.mjs le assembla
 * in shared/words/definitions.ts e le verifica.
 *
 * Si lancia con:
 *   node --env-file=.env scripts/generate-definitions.mjs          (tutte)
 *   node --env-file=.env scripts/generate-definitions.mjs 50       (solo 50, per provare)
 *
 * `--env-file` fa leggere a Node il file .env, dove sta ANTHROPIC_API_KEY.
 * Il .env è in .gitignore, quindi la chiave non finisce mai su GitHub.
 *
 * È pensato per essere rilanciato: riparte sempre dalle parole ancora mancanti,
 * quindi un'interruzione a metà non fa perdere nulla e non fa ripagare ciò che
 * è già stato generato.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache");
const CHUNKS = join(CACHE, "chunks");

/**
 * Quante parole per richiesta. Cinquanta è un compromesso: una richiesta sola
 * da 2.115 parole sarebbe lentissima e, se fallisse, si perderebbe tutto;
 * una richiesta per parola moltiplicherebbe per 2.115 il costo fisso delle
 * istruzioni, che vengono rimandate a ogni chiamata.
 */
const BATCH_SIZE = 50;

/**
 * Quante richieste in volo insieme. Non tutte: ogni account ha un limite di
 * richieste al minuto, e superarlo fa rifiutare le chiamate. Quattro è
 * prudente e finisce comunque in pochi minuti.
 */
const CONCURRENCY = 4;

/** Quante volte riprovare una richiesta fallita prima di arrendersi. */
const MAX_RETRIES = 3;

const MODEL = "claude-opus-5";

// === Pezzo 1: capire cosa manca ============================================

/**
 * Restituisce le parole che non hanno ancora una definizione, nell'ordine
 * della lista di partenza.
 */
function missingWords() {
  const words = readFileSync(join(CACHE, "words.txt"), "utf8")
    .trim()
    .split("\n");

  const done = new Set();
  const files = readdirSync(CHUNKS).filter((name) => name.endsWith(".json"));
  for (const file of files) {
    const chunk = JSON.parse(readFileSync(join(CHUNKS, file), "utf8"));
    for (const word of Object.keys(chunk)) {
      done.add(word);
    }
  }

  return words.filter((word) => !done.has(word));
}

// === Pezzo 2: dire a Claude che forma deve avere la risposta ===============

/**
 * Lo schema della risposta attesa.
 *
 * Questa è la parte importante: NON stiamo scrivendo nelle istruzioni
 * "rispondi in JSON e per favore non aggiungere commenti", sperando che vada
 * bene. Stiamo passando all'API la forma esatta dei dati, e l'API garantisce
 * che la risposta la rispetti. Si chiama "structured output".
 *
 * Conseguenza pratica: non serve un parser difensivo che ripulisca la risposta
 * dalle frasi di cortesia o dai blocchi di codice markdown, perché non possono
 * esserci. `level` è addirittura vincolato ai tre valori ammessi.
 */
const SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          pos: { type: "string" },
          ipa: { type: "string" },
          level: { type: "string", enum: ["common", "uncommon", "rare"] },
          en: { type: "string" },
          example: { type: "string" },
        },
        required: ["word", "pos", "ipa", "level", "en", "example"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

/**
 * Le istruzioni, identiche per tutte le richieste. Sono l'equivalente scritto
 * dei criteri che avevamo fissato a mano: inglese semplice, una frase che
 * contiene davvero la parola, niente traduzioni italiane.
 *
 * Stanno nel prompt di sistema e non nel messaggio, così restano invariate fra
 * una richiesta e l'altra — e l'API le riconosce come già viste, facendole
 * costare meno.
 */
const SYSTEM_PROMPT = `You write dictionary entries for a word game that helps people learn English vocabulary. The players are not native speakers.

For each word you are given, produce exactly one entry with these fields:

- "word": the word exactly as given, lowercase.
- "pos": the part of speech, in English. One of: noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, determiner. If the word is commonly used as more than one, join them with " · " (space, middle dot, space), most common first. Never more than two.
- "ipa": the pronunciation in IPA, wrapped in slashes, General American. Example: "/aɪl/".
- "level": how worth learning the word is — "common" for everyday vocabulary, "uncommon" for words an intermediate learner meets occasionally, "rare" for archaic, technical or literary words.
- "en": one short definition in simple English, 6 to 14 words, ending with a full stop. Define the most frequent sense. If a second sense is genuinely common, add it after a semicolon or "or". Never use the word itself in its own definition.
- "example": one natural sentence, 5 to 12 words, that uses the word (any inflected form is fine) and makes its meaning clear from context. End with a full stop. Do not put the word in quotes.

Write for clarity, not for style. Keep every entry self-contained.

Return one entry per word given, in the same order, and no extra words.`;

// === Pezzo 3: una richiesta ================================================

const client = new Anthropic(); // legge da sola ANTHROPIC_API_KEY dall'ambiente

/**
 * Chiede le definizioni di un gruppo di parole e restituisce l'oggetto pronto
 * da salvare: { parola: {pos, ipa, level, en, example}, ... }.
 *
 * Riprova in caso di errore, aspettando sempre di più fra un tentativo e
 * l'altro ("backoff"): se il servizio è sovraccarico, ritentare subito peggiora
 * le cose; aspettare 2, poi 4, poi 8 secondi gli dà il tempo di riprendersi.
 */
async function generateBatch(words, attempt = 1) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      // `effort` regola quanto il modello ragiona prima di rispondere: qui il
      // compito è meccanico e ben specificato, quindi "medium" basta e costa
      // meno. Alzalo a "high" se le voci non ti convincono.
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [{ role: "user", content: words.join("\n") }],
    });

    // Con lo structured output la risposta è un unico blocco di testo che
    // contiene JSON valido e conforme allo schema.
    const text = response.content.find((block) => block.type === "text")?.text;
    const { entries } = JSON.parse(text);

    // Si ricostruisce l'oggetto usando la parola come chiave, scartando il
    // campo "word" che a quel punto è ridondante.
    const result = {};
    for (const { word, ...fields } of entries) {
      result[word] = fields;
    }

    // Controllo: il modello ha risposto per tutte le parole chieste?
    //
    // Se ne mancano poche si tengono comunque le altre, e le mancanti
    // ricompariranno al prossimo lancio — `missingWords()` calcola cosa resta
    // da fare leggendo ciò che è stato salvato, quindi non serve altra logica.
    // Buttare via 49 voci valide perché una manca sarebbe uno spreco (ed è
    // esattamente l'errore che questo script faceva nella prima versione).
    //
    // Se invece ne manca più di un quinto, la risposta è andata storta sul
    // serio: meglio rifare la richiesta da capo.
    const missing = words.filter((w) => !result[w]);
    if (missing.length > words.length / 5) {
      throw new Error(`risposta troppo incompleta (${missing.length} mancanti)`);
    }
    if (missing.length) {
      console.log(`  ℹ️  non generate, verranno ritentate: ${missing.join(", ")}`);
    }

    return result;
  } catch (error) {
    if (attempt >= MAX_RETRIES) throw error;
    const waitSeconds = 2 ** attempt;
    console.log(`  ⚠️  ${error.message} — riprovo fra ${waitSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    return generateBatch(words, attempt + 1);
  }
}

// === Pezzo 4: il ciclo principale ==========================================

/** Spezza un array in gruppi da `size` elementi. */
function chunked(array, size) {
  const groups = [];
  for (let i = 0; i < array.length; i += size) {
    groups.push(array.slice(i, i + size));
  }
  return groups;
}

/** Il numero del prossimo file di blocco (003, 004, …), senza sovrascrivere. */
function nextChunkNumber() {
  const numbers = readdirSync(CHUNKS)
    .filter((name) => name.endsWith(".json"))
    .map((name) => Number(name.replace(".json", "")))
    .filter((n) => Number.isInteger(n));
  return Math.max(0, ...numbers) + 1;
}

async function main() {
  mkdirSync(CHUNKS, { recursive: true });

  // Un numero passato da riga di comando limita quante parole fare, per
  // provare lo script senza lanciarlo su tutte e 2.115.
  const limit = Number(process.argv[2]) || Infinity;
  const todo = missingWords().slice(0, limit);

  if (!todo.length) {
    console.log("✔ Niente da fare: tutte le parole hanno già una definizione.");
    return;
  }

  const groups = chunked(todo, BATCH_SIZE);
  console.log(
    `Da generare: ${todo.length} parole in ${groups.length} richieste, ` +
      `${CONCURRENCY} alla volta, con ${MODEL}.\n`,
  );

  let chunkNumber = nextChunkNumber();
  let doneCount = 0;
  const started = Date.now();

  // Si lavora a ondate di CONCURRENCY richieste: si lanciano tutte insieme e
  // si aspetta che finiscano (Promise.all), poi si passa all'ondata dopo.
  for (const wave of chunked(groups, CONCURRENCY)) {
    const results = await Promise.all(
      wave.map(async (words) => {
        try {
          return { words, entries: await generateBatch(words) };
        } catch (error) {
          // Un gruppo fallito non ferma gli altri: si segnala e si prosegue.
          // Rilanciando lo script, quelle parole risulteranno ancora mancanti
          // e verranno ritentate.
          console.error(`✗ ${words[0]}…${words.at(-1)}: ${error.message}`);
          return null;
        }
      }),
    );

    // Il salvataggio avviene qui, fuori dalle richieste parallele, così i file
    // vengono numerati in ordine e senza collisioni.
    for (const result of results) {
      if (!result) continue;
      const name = String(chunkNumber++).padStart(3, "0") + ".json";
      writeFileSync(
        join(CHUNKS, name),
        JSON.stringify(result.entries, null, 2) + "\n",
      );
      doneCount += result.words.length;
      console.log(
        `✔ ${name}  ${result.words[0]} … ${result.words.at(-1)}  ` +
          `(${doneCount}/${todo.length})`,
      );
    }
  }

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\nFatto: ${doneCount} parole in ${minutes} minuti.`);
  console.log("Ora lancia:  node scripts/build-definitions.mjs");
}

main();
