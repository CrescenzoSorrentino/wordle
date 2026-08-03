<script setup lang="ts">
/**
 * Wordpace — il gioco intero: la griglia, le due tastiere (fisica e a
 * schermo), il cruscotto livello/tempo/punteggio, il conto alla rovescia di
 * ogni livello e la classifica di fine partita. Qui stanno l'interfaccia e lo
 * stato reattivo; le regole pure (valutazione, validazione, formula del timer)
 * vivono in #shared/wordle, quelle della classifica in #shared/leaderboard.
 */
import {
  MAX_ATTEMPTS,
  WORD_LENGTH,
  evaluateGuess,
  isValidWord,
  pickRandomAnswer,
  timeForLevel,
  MAX_TIME,
  TIME_BONUS_CORRECT,
  TIME_BONUS_PRESENT,
  TIME_PENALTY,
  EXPLANATION_TIME,
  type LetterState,
} from "#shared/wordle";
import {
  LEADERBOARD_SIZE,
  NICKNAME_MAX_LENGTH,
  isValidNickname,
  sanitizeNickname,
  type LeaderboardEntry,
} from "#shared/leaderboard";
// Solo il TIPO, non i dati. Un `import type` sparisce quando il codice viene
// tradotto in JavaScript: serve a TypeScript per i controlli e non trascina
// nel browser un solo byte del dizionario. Importare `getDefinition` come
// facevamo prima ci riporterebbe dentro tutte le 2.315 voci.
import type { WordDefinition } from "#shared/words/definitions";

// Le tre fasi del gioco: si sta giocando, si sta leggendo la spiegazione della
// parola, oppure la partita è finita. Tutto il resto del codice si regola su
// questa: le funzioni di input si fermano da sole appena la fase non è
// "playing".
type GameStatus = "playing" | "explaining" | "lost";

// Dove si va quando la spiegazione finisce. Volutamente NON ripete la parola
// "explaining": quella informazione la dà già GameStatus, e un dato scritto in
// due posti prima o poi diverge.
type NextStep = "next-level" | "game-over";

// Voci preferite per la pronuncia, in ordine: si prende la prima disponibile.
// L'ordine NON è un dettaglio estetico. Le voci marcate "en-US" includono anche
// gli effetti sonori scherzo di macOS (Zarvox, Boing, Bollicine…): chiedendo
// genericamente una voce inglese si rischia di ottenere un robot da cartone
// animato. Meglio nominare quelle buone e tenere il generico come ripiego.
const PREFERRED_VOICES = [
  "Google US English", // la migliore, ma solo su Chrome
  "Samantha", // voce di sistema macOS, sempre presente
  "Daniel", // britannica, ripiego di qualità
];

// Disposizione della tastiera a schermo. "enter" e "back" sono i due tasti
// azione, tutto il resto sono lettere.
const KEYBOARD_ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["enter", "z", "x", "c", "v", "b", "n", "m", "back"],
];

// === Stato del gioco (reattivo: lo schermo lo segue da solo) ===

const answer = ref(""); // la parola segreta di questo livello
const guesses = ref<string[]>([]); // i tentativi già inviati, in minuscolo
const evaluations = ref<LetterState[][]>([]); // una riga di colori per tentativo
const currentGuess = ref(""); // la parola che si sta scrivendo ora
const status = ref<GameStatus>("playing"); // in gioco / spiegazione / persa
const nextStep = ref<NextStep>("next-level"); // dove si va dopo la spiegazione
const level = ref(1); // livello attuale, parte da 1
const score = ref(0); // punti accumulati in questa partita
const timeLeft = ref(0); // secondi rimasti sulla parola in corso
const message = ref(""); // messaggio breve ("Not in word list", "+15 seconds!")
const explanationTimeLeft = ref(0); // secondi rimasti per leggere la spiegazione

// Stato della classifica (si riempie quando la partita finisce).
const leaderboard = ref<LeaderboardEntry[]>([]); // i punteggi migliori attuali
const qualifies = ref(false); // questa partita è entrata nei primi 10?
const nick = ref(""); // il nome che si sta scrivendo nel modulo
const scoreSubmitted = ref(false); // punteggio di questa partita già salvato?

let messageTimer: ReturnType<typeof setTimeout> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let explanationTimer: ReturnType<typeof setInterval> | undefined;

// Quali scoperte hanno già fruttato tempo, così lo stesso verde o giallo non
// può essere sfruttato di nuovo reinviandolo. Si azzerano a ogni nuova parola.
let rewardedGreens = new Set<number>(); // posizioni verdi già premiate
let rewardedYellows = new Set<string>(); // lettere gialle già premiate

// La voce scelta per la pronuncia. Non è reattiva: a schermo non ci va mai.
let englishVoice: SpeechSynthesisVoice | undefined;

// === Dati derivati (calcolati dallo stato qui sopra) ===

/**
 * Lo stato migliore conosciuto per ogni lettera già usata, per colorare la
 * tastiera a schermo. Priorità: correct > present > absent — una lettera
 * diventata verde non deve mai retrocedere visivamente a gialla.
 */
const keyStates = computed<Record<string, LetterState>>(() => {
  const rank: Record<LetterState, number> = {
    absent: 0,
    present: 1,
    correct: 2,
  };
  const map: Record<string, LetterState> = {};

  guesses.value.forEach((guess, row) => {
    const states = evaluations.value[row]!;
    for (let i = 0; i < guess.length; i++) {
      const letter = guess[i]!;
      const next = states[i]!;
      // Sostituisce il colore solo se quello nuovo vale di più.
      if (map[letter] === undefined || rank[next] > rank[map[letter]!]) {
        map[letter] = next;
      }
    }
  });

  return map;
});

/** Il nome ripulito del giocatore, per evidenziare la sua riga in classifica. */
const myNick = computed(() => sanitizeNickname(nick.value));

/** timeLeft (es. 187) formattato come minuti:secondi (es. "3:07"). */
const timeDisplay = computed(() => {
  const minutes = Math.floor(timeLeft.value / 60);
  const seconds = timeLeft.value % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
});

/**
 * La griglia 6 x 5 già pronta da disegnare. Ogni cella sa già la sua lettera e
 * il suo aspetto, così il template si limita a dipingerla senza dover decidere
 * se una riga è inviata, attiva o vuota. Si ricalcola da sola ogni volta che
 * lo stato qui sopra cambia.
 */
const board = computed(() => {
  const rows: { letter: string; state: LetterState | "empty" | "filled" }[][] =
    [];

  for (let r = 0; r < MAX_ATTEMPTS; r++) {
    const cells: { letter: string; state: LetterState | "empty" | "filled" }[] =
      [];

    // La riga r è già stata inviata? È quella che si sta scrivendo adesso?
    const submitted = r < guesses.value.length;
    const isActiveRow =
      r === guesses.value.length && status.value === "playing";

    for (let c = 0; c < WORD_LENGTH; c++) {
      if (submitted) {
        // Tentativo confermato: si prendono lettera e colore già calcolati.
        cells.push({
          letter: guesses.value[r]![c]!,
          state: evaluations.value[r]![c]!,
        });
      } else if (isActiveRow && c < currentGuess.value.length) {
        // La riga attiva, ma solo fin dove il giocatore ha scritto.
        cells.push({ letter: currentGuess.value[c]!, state: "filled" });
      } else {
        // Tutto il resto è ancora una cella vuota.
        cells.push({ letter: "", state: "empty" });
      }
    }

    rows.push(cells);
  }

  return rows;
});

/**
 * Voce vuota, usata finché quella vera non è arrivata dal server. Il template
 * salta le righe vuote, quindi nel caso pessimo si vede una finestra sobria
 * invece di un errore.
 */
const EMPTY_DEFINITION: WordDefinition = {
  pos: "",
  ipa: "",
  level: "",
  en: "",
  example: "",
};

/**
 * La voce di dizionario della parola in corso.
 *
 * Era una computed, ed era la scelta giusta finché il dizionario stava in
 * memoria: il testo si ricavava da `answer` all'istante. Ora arriva dalla rete,
 * cioè NON è più ricavabile — è un dato che va atteso e conservato. Quindi
 * torna a essere un ref, aggiornato da fetchDefinition().
 *
 * La regola generale: computed per ciò che si calcola, ref per ciò che arriva.
 */
const currentDefinition = ref<WordDefinition>(EMPTY_DEFINITION);

/**
 * Quanto resta del tempo di lettura, in percentuale, per la barra che si
 * svuota. Una barra dice "quanto manca" a colpo d'occhio meglio di un numero
 * che scende, e non costringe a leggere mentre si sta già leggendo altro.
 */
const explanationProgress = computed(
  () => `${(explanationTimeLeft.value / EXPLANATION_TIME) * 100}%`,
);

// === Azioni: le funzioni che modificano lo stato ===

/** Aggiunge una lettera alla riga attiva, se c'è spazio e la partita è in corso. */
function addLetter(letter: string) {
  if (status.value !== "playing") return;
  if (currentGuess.value.length >= WORD_LENGTH) return;
  currentGuess.value += letter;
}

/** Cancella l'ultima lettera della riga attiva. */
function removeLetter() {
  if (status.value !== "playing") return;
  currentGuess.value = currentGuess.value.slice(0, -1);
}

/** Mostra un messaggio breve che si cancella da solo dopo un attimo. */
function flashMessage(text: string) {
  message.value = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message.value = "";
  }, 1600);
}

/** Ferma il conto alla rovescia (se ne sta girando uno). */
function stopTimer() {
  clearInterval(countdownTimer);
  countdownTimer = undefined;
}

/**
 * Annulla la sveglia della spiegazione presso il browser. Un setInterval non si
 * ferma mai da solo: senza questa, il contatore andrebbe sotto zero e
 * finishExplanation verrebbe richiamata ogni secondo, all'infinito.
 */
function stopExplanationTimer() {
  clearInterval(explanationTimer);
  explanationTimer = undefined;
}

/**
 * Mette il gioco in pausa e mostra la spiegazione della parola appena conclusa.
 *
 * `step` è il biglietto con la destinazione: chi chiama sa se si è vinto il
 * livello o persa la partita, e lo comunica qui. La funzione se lo appunta in
 * `nextStep` e lo rilegge finishExplanation quando i secondi sono finiti.
 *
 * Spegnere il timer di gioco è la PRIMA cosa: altrimenti continua a scalare
 * secondi mentre il giocatore legge, e può chiudere la partita a metà lettura.
 */
function startExplanation(step: NextStep) {
  stopTimer();
  nextStep.value = step;
  status.value = "explaining";
  explanationTimeLeft.value = EXPLANATION_TIME;
  explanationTimer = setInterval(() => {
    explanationTimeLeft.value--;
    if (explanationTimeLeft.value <= 0) {
      finishExplanation();
    }
  }, 1000);
}

/**
 * Chiude la spiegazione e va dove diceva il biglietto. Chiamata sia allo
 * scadere dei secondi sia dal pulsante "Continua", quindi deve stare fuori
 * dalla callback del setInterval: codice sepolto lì dentro non è richiamabile
 * da nessun altro.
 */
function finishExplanation() {
  stopExplanationTimer();
  if (nextStep.value === "next-level") {
    nextLevel();
  } else {
    endRun();
  }
}

/**
 * Sceglie la voce con cui pronunciare le parole, in ordine di preferenza.
 *
 * Va richiamata più volte, e non è uno spreco: getVoices() è ASINCRONA nei
 * fatti. Il browser costruisce la lista interrogando il sistema operativo, e
 * alla prima chiamata spesso risponde con un array vuoto. Per questo la
 * ripetiamo all'evento "voiceschanged", che scatta quando la lista è pronta.
 */
function pickEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return; // lista non ancora pronta: riproveremo

  for (const name of PREFERRED_VOICES) {
    const match = voices.find((voice) => voice.name === name);
    if (match) {
      englishVoice = match;
      return;
    }
  }

  // Nessuna delle preferite: meglio una voce inglese qualsiasi che il silenzio.
  englishVoice = voices.find((voice) => voice.lang.startsWith("en"));
}

/**
 * Fa pronunciare la parola alla voce di sistema. Niente rete e niente file
 * audio: il sintetizzatore è già nel browser.
 *
 * La lingua va imposta a mano, altrimenti il sistema userebbe la propria (su un
 * Mac italiano leggerebbe "aisle" all'italiana, cioè proprio l'errore che
 * vogliamo evitare). Ma `lang` è solo una richiesta: la voce va scelta
 * esplicitamente, o il browser può pescare uno degli effetti sonori scherzo di
 * macOS, che sono anch'essi marcati "en-US". Se la lista non è ancora pronta si
 * lascia decidere lui: meglio una voce buffa che nessun suono.
 *
 * cancel() prima di speak() perché speechSynthesis è una CODA: premendo il
 * pulsante cinque volte, senza svuotarla, direbbe la parola cinque volte di
 * fila.
 */
function speakWord() {
  const utterance = new SpeechSynthesisUtterance(answer.value);
  utterance.lang = "en-US";
  if (englishVoice) utterance.voice = englishVoice;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

/** Chiude la partita: ferma l'orologio, mostra Game Over, controlla la classifica. */
function endRun() {
  stopTimer();
  status.value = "lost";
  finishRun();
}

/**
 * A partita finita: scarica i punteggi migliori e decide se questo punteggio si
 * merita un posto (classifica non ancora piena, oppure batte l'ultimo dei
 * primi). Un punteggio di zero non entra mai. Se la rete non risponde non
 * succede nulla di grave: niente modulo del nome e lista vuota.
 */
async function finishRun() {
  try {
    leaderboard.value = await $fetch<LeaderboardEntry[]>("/api/leaderboard");
    const lowest = leaderboard.value[leaderboard.value.length - 1];
    qualifies.value =
      score.value > 0 &&
      (leaderboard.value.length < LEADERBOARD_SIZE ||
        score.value > (lowest?.score ?? 0));
  } catch (e) {
    console.error("Could not load leaderboard:", e);
    leaderboard.value = [];
    qualifies.value = false;
  }
}

/** Salva il nome scritto col punteggio della partita, poi ricarica la classifica. */
async function submitScore() {
  if (!isValidNickname(nick.value)) return;
  try {
    await $fetch("/api/leaderboard", {
      method: "POST",
      body: { nick: sanitizeNickname(nick.value), score: score.value },
    });
    scoreSubmitted.value = true;
    qualifies.value = false; // nasconde il modulo del nome
    leaderboard.value = await $fetch<LeaderboardEntry[]>("/api/leaderboard");
  } catch (e) {
    console.error("Could not submit score:", e);
  }
}

/**
 * Somma il tempo previsto per questo livello a quello ancora rimasto (il tempo
 * si porta avanti, così chi risolve in fretta mette da parte secondi), con un
 * tetto a MAX_TIME, poi fa scattare il conto alla rovescia una volta al
 * secondo. Quando arriva a zero la partita finisce.
 */
function startTimer() {
  stopTimer(); // mai due conti alla rovescia in funzione insieme
  timeLeft.value = Math.min(
    timeLeft.value + timeForLevel(level.value),
    MAX_TIME,
  );
  countdownTimer = setInterval(() => {
    timeLeft.value--;
    if (timeLeft.value <= 0) {
      startExplanation("game-over");
    }
  }, 1000);
}

/** Valida e invia la riga attiva come tentativo. */
function submitGuess() {
  if (status.value !== "playing") return;

  // Due motivi per cui un tentativo può essere rifiutato, con messaggi diversi.
  if (currentGuess.value.length < WORD_LENGTH) {
    flashMessage("Not enough letters");
    return;
  }
  if (!isValidWord(currentGuess.value)) {
    flashMessage("Not in word list");
    return;
  }

  // Accettato: lo si valuta e si registrano sia la parola sia i suoi colori.
  const guess = currentGuess.value;
  const states = evaluateGuess(guess, answer.value);
  guesses.value.push(guess);
  evaluations.value.push(states);
  currentGuess.value = "";

  // Il tempo si guadagna solo per scoperte NUOVE, così non si può sfruttare
  // la stessa lettera più volte per accumulare secondi.
  let bonus = 0;
  for (let i = 0; i < states.length; i++) {
    const letter = guess[i]!;
    if (states[i] === "correct" && !rewardedGreens.has(i)) {
      rewardedGreens.add(i);
      bonus += TIME_BONUS_CORRECT;
    } else if (states[i] === "present" && !rewardedYellows.has(letter)) {
      rewardedYellows.add(letter);
      bonus += TIME_BONUS_PRESENT;
    }
  }
  if (bonus > 0) {
    timeLeft.value += bonus;
    flashMessage(`+${bonus} seconds!`);
  } else if (guess !== answer.value) {
    timeLeft.value = Math.max(0, timeLeft.value - TIME_PENALTY);
    flashMessage(`-${TIME_PENALTY} seconds!`);
  }

  // Fine del turno, in un modo o nell'altro: si passa la mano alla spiegazione,
  // che dopo i suoi secondi porterà al livello nuovo o al Game Over. I punti si
  // incassano SUBITO, prima che la griglia venga azzerata: wordScore() conta i
  // tentativi usati, e fra venti secondi quel dato non ci sarà più.
  if (guess === answer.value) {
    score.value += wordScore();
    startExplanation("next-level");
  } else if (guesses.value.length >= MAX_ATTEMPTS || timeLeft.value <= 0) {
    startExplanation("game-over");
  }
}

/**
 * Chiede al server la voce di dizionario di `word` e la mette da parte.
 *
 * Viene lanciata all'INIZIO del livello, non quando serve mostrarla: così la
 * mezza attesa della rete cade mentre il giocatore sta indovinando, e quando la
 * finestra si apre il testo è già lì da un pezzo. L'attesa esiste ancora, ma in
 * un momento in cui nessuno la guarda.
 *
 * Non si aspetta il risultato (nessun await da chi la chiama): il gioco deve
 * partire subito, la definizione arriverà quando arriva.
 */
async function fetchDefinition(word: string) {
  currentDefinition.value = EMPTY_DEFINITION;
  try {
    const definition = await $fetch<WordDefinition>("/api/definition", {
      query: { word },
    });
    // La parola potrebbe essere già cambiata (partita nuova, livello saltato):
    // in tal caso questa risposta è vecchia e va buttata, o mostreremmo la
    // spiegazione di una parola che il giocatore non sta più giocando.
    if (answer.value === word) {
      currentDefinition.value = definition;
    }
  } catch (e) {
    // Rete assente o server giù: si resta sulla voce vuota. Una spiegazione
    // mancante è un difetto estetico, non deve fermare la partita.
    console.error("Could not load definition:", e);
  }
}

/** Carica una parola nuova e pulisce la griglia per il turno successivo. */
function loadWord() {
  answer.value = pickRandomAnswer();
  fetchDefinition(answer.value); // parte adesso, arriverà molto prima che serva
  guesses.value = [];
  evaluations.value = [];
  currentGuess.value = "";
  status.value = "playing";
  rewardedGreens = new Set(); // parola nuova → nessun premio ancora dato
  rewardedYellows = new Set();
  startTimer(); // nuovo tempo per questo livello, più corto del precedente
}

/** Avvia una partita nuova dal livello 1 con punteggio azzerato. */
function newRun() {
  level.value = 1;
  score.value = 0;
  timeLeft.value = 0;
  qualifies.value = false;
  scoreSubmitted.value = false;
  nick.value = "";
  loadWord();
}

/** Parola indovinata: si sale di un livello e si carica la parola successiva. */
function nextLevel() {
  level.value++;
  flashMessage(`Level ${level.value}!`);
  loadWord();
}

/** Punti per la parola risolta: più tentativi risparmiati e livello più alto
 *  valgono di più. */
function wordScore(): number {
  const unused = MAX_ATTEMPTS - guesses.value.length;
  return (10 + unused * 5) * level.value;
}

/**
 * Punto d'ingresso unico per qualsiasi tasto, da entrambe le tastiere. Il tasto
 * è uno fra: "enter", "back", oppure una singola lettera a–z.
 */
function handleKey(key: string) {
  if (key === "enter") {
    submitGuess();
  } else if (key === "back") {
    removeLetter();
  } else if (/^[a-z]$/.test(key)) {
    addLetter(key);
  }
}

/** Traduce la pressione di un tasto fisico nei nostri nomi, poi la smista. */
function onPhysicalKey(event: KeyboardEvent) {
  // Ignora le scorciatoie (Cmd/Ctrl/Alt) per non rubare copia, ricarica…
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === "Enter") {
    handleKey("enter");
  } else if (event.key === "Backspace") {
    handleKey("back");
  } else {
    handleKey(event.key.toLowerCase());
  }
}

// Blocca lo scorrimento della pagina ogni volta che c'è una finestra sopra il
// gioco (spiegazione o Game Over), e lo ripristina appena si torna a giocare.
// La condizione nomina l'unica fase "libera" invece di elencare quelle bloccate:
// così una quarta fase futura sarà gestita correttamente senza toccare nulla.
watch(status, (current) => {
  document.body.style.overflow = current !== "playing" ? "hidden" : "";
});

// Quando il componente compare a schermo: avvia la prima partita e si mette in
// ascolto della tastiera. Quando sparisce, smette di ascoltare (pulizia).
onMounted(() => {
  newRun();
  window.addEventListener("keydown", onPhysicalKey);

  // Si prova subito (a volte la lista c'è già) e ci si iscrive all'evento per
  // quando arriva davvero.
  pickEnglishVoice();
  speechSynthesis.addEventListener("voiceschanged", pickEnglishVoice);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onPhysicalKey);
  speechSynthesis.removeEventListener("voiceschanged", pickEnglishVoice);
  stopTimer();
  stopExplanationTimer();
  document.body.style.overflow = ""; // mai lasciare la pagina bloccata
});
</script>

<template>
  <section class="wordle" aria-label="Wordpace game">
    <div class="wordle__hud">
      <div class="wordle__stat">
        <span class="wordle__stat-label">Level</span>
        <span class="wordle__stat-value">{{ level }}</span>
      </div>
      <div
        class="wordle__stat wordle__stat--time"
        :class="{
          'wordle__stat--urgent': status === 'playing' && timeLeft <= 15,
        }"
      >
        <span class="wordle__stat-label">Time</span>
        <span class="wordle__stat-value">{{ timeDisplay }}</span>
      </div>
      <div class="wordle__stat">
        <span class="wordle__stat-label">Score</span>
        <span class="wordle__stat-value">{{ score }}</span>
      </div>
    </div>

    <!-- Messaggio breve. aria-live fa sì che i lettori di schermo lo annuncino. -->
    <p class="wordle__message" role="status" aria-live="polite">
      {{ message }}
    </p>

    <div class="wordle__board">
      <!-- Una riga per ogni elemento di `board` (6 righe). -->
      <div v-for="(row, rowIndex) in board" :key="rowIndex" class="wordle__row">
        <!-- Una cella per ogni lettera di quella riga (5 celle). -->
        <div
          v-for="(cell, cellIndex) in row"
          :key="cellIndex"
          class="wordle__cell"
          :class="`wordle__cell--${cell.state}`"
        >
          {{ cell.letter.toUpperCase() }}
        </div>
      </div>
    </div>

    <!-- Spiegazione: finestra che appare fra un livello e l'altro (e prima del
         Game Over), col significato della parola appena giocata. Il pulsante
         chiama la stessa funzione dello scadere dei secondi: la anticipa. -->
    <div v-if="status === 'explaining'" class="wordle__overlay">
      <div
        class="wordle__result"
        role="dialog"
        aria-modal="true"
        aria-label="Word explanation"
      >
        <!-- Barra che si svuota: dice quanto manca senza costringere a leggere
             un numero mentre si sta già leggendo la definizione. -->
        <div
          class="wordle__progress"
          role="progressbar"
          aria-label="Time left to read"
          :aria-valuenow="explanationTimeLeft"
          :aria-valuemax="EXPLANATION_TIME"
        >
          <div
            class="wordle__progress-bar"
            :style="{ width: explanationProgress }"
          />
        </div>

        <p class="wordle__result-label">The word was</p>

        <!-- Il lemma e il suo pulsante audio stanno insieme: è lì che uno
             cerca il modo di sentire come si pronuncia. -->
        <div class="wordle__headword">
          <h2 class="wordle__result-title">{{ answer.toUpperCase() }}</h2>
          <!-- La voce di sistema è la pronuncia autorevole; l'IPA è l'aiuto
               visivo. Se i due divergono, ha ragione l'audio. -->
          <button
            class="wordle__speak"
            type="button"
            :aria-label="`Listen to the pronunciation of ${answer}`"
            @click="speakWord"
          >
            🔊
          </button>
        </div>

        <!-- Riga dei dati brevi: categoria, pronuncia e quanto vale la pena
             impararla. Ogni pezzo compare solo se c'è, così una parola non
             ancora generata mostra solo il testo di ripiego. -->
        <p
          v-if="
            currentDefinition.pos ||
            currentDefinition.ipa ||
            currentDefinition.level
          "
          class="wordle__definition-meta"
        >
          <span v-if="currentDefinition.pos">{{ currentDefinition.pos }}</span>
          <span v-if="currentDefinition.ipa" class="wordle__definition-ipa">
            {{ currentDefinition.ipa }}
          </span>
          <span
            v-if="currentDefinition.level"
            class="wordle__definition-level"
            :class="`wordle__definition-level--${currentDefinition.level}`"
          >
            {{ currentDefinition.level }}
          </span>
        </p>

        <p class="wordle__definition wordle__definition--en">
          {{ currentDefinition.en }}
        </p>
        <p
          v-if="currentDefinition.example"
          class="wordle__definition wordle__definition--example"
        >
          “{{ currentDefinition.example }}”
        </p>

        <button class="wordle__again" type="button" @click="finishExplanation">
          Continue
        </button>
      </div>
    </div>

    <!-- Game Over: finestra modale che appare a partita finita. -->
    <div v-if="status === 'lost'" class="wordle__overlay">
      <div
        class="wordle__result"
        role="dialog"
        aria-modal="true"
        aria-label="Game over"
      >
        <!-- A fine partita la domanda del giocatore è una sola: "quanto ho
             fatto?". Il punteggio è quindi il pezzo grande; il resto lo
             accompagna. -->
        <p class="wordle__result-label">Game over</p>
        <p class="wordle__result-score">{{ score }}</p>
        <p class="wordle__result-stats">
          Points · Reached level <strong>{{ level }}</strong>
        </p>
        <p class="wordle__result-text">
          Stopped by <strong>{{ answer.toUpperCase() }}</strong>
        </p>

        <!-- Richiesta del nome: solo se il punteggio è entrato nei primi 10 e non
           è ancora stato salvato. -->
        <form
          v-if="qualifies && !scoreSubmitted"
          class="wordle__nickname"
          @submit.prevent="submitScore"
        >
          <label class="wordle__nickname-label" for="nick">
            Top {{ LEADERBOARD_SIZE }}! Enter your name:
          </label>
          <input
            id="nick"
            class="wordle__nickname-input"
            v-model="nick"
            :maxlength="NICKNAME_MAX_LENGTH"
            autocomplete="off"
          />
          <button class="wordle__again" type="submit">Save</button>
        </form>

        <!-- La classifica vera e propria. -->
        <ol v-if="leaderboard.length" class="wordle__scores">
          <li
            v-for="(entry, i) in leaderboard"
            :key="i"
            class="wordle__scores-row"
            :class="{
              'wordle__scores-row--me':
                scoreSubmitted &&
                entry.nick === myNick &&
                entry.score === score,
            }"
          >
            <span class="wordle__scores-rank">{{ i + 1 }}</span>
            <span class="wordle__scores-nick">{{ entry.nick }}</span>
            <span class="wordle__scores-score">{{ entry.score }}</span>
          </li>
        </ol>

        <button class="wordle__again" type="button" @click="newRun">
          Play again
        </button>
      </div>
    </div>

    <!-- Tastiera a schermo: l'unico modo per scrivere su un dispositivo touch. -->
    <div class="wordle__keyboard" aria-label="Keyboard">
      <div
        v-for="(krow, kIndex) in KEYBOARD_ROWS"
        :key="kIndex"
        class="wordle__keyboard-row"
      >
        <button
          v-for="key in krow"
          :key="key"
          class="wordle__key"
          :class="[
            { 'wordle__key--wide': key === 'enter' || key === 'back' },
            keyStates[key] ? `wordle__key--${keyStates[key]}` : '',
          ]"
          type="button"
          :aria-label="key === 'back' ? 'Backspace' : key"
          @click="handleKey(key)"
        >
          <template v-if="key === 'enter'">
            <span class="wordle__key-text">Enter</span>
            <span class="wordle__key-icon" aria-hidden="true">⏎</span>
          </template>
          <template v-else-if="key === 'back'">⌫</template>
          <template v-else>{{ key.toUpperCase() }}</template>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wordle {
  /* Tutti i colori in un posto solo: cambiandone uno qui, cambia ovunque. */
  --wg-gap: 5px;
  --wg-radius: 4px;

  --wg-text: #1a1a1a;
  --wg-dim: #6e7275; /* testi secondari: 5,4:1 su bianco, leggibile */
  --wg-border: #d3d6da; /* bordo delle celle vuote e dei tasti */
  --wg-border-filled: #878a8c; /* cella scritta ma non ancora inviata */
  --wg-surface: #f6f7f8; /* fondino appena accennato per i blocchi */

  /* I tre colori storici di Wordle. Il verde è appena più scuro
     dell'originale (#6aaa64 → #5f9e58): a occhio è lo stesso colore, ma il
     testo bianco sopra passa da 2,8:1 a 3,3:1, cioè da illeggibile a
     conforme. Il giallo è sceso da #c9b458 a #ab8f3a per la stessa ragione:
     2,3:1 → 3,1:1. Non è un valore scelto a occhio, è il minimo che supera la
     soglia — qualunque tonalità più chiara non ci arriva, e avremmo cambiato
     colore senza guadagnarci niente. */
  --wg-correct: #5f9e58;
  --wg-present: #ab8f3a;
  --wg-absent: #787c7e;
  --wg-urgent: #d0342c;

  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.1rem;
  width: 100%;
  max-width: 30rem; /* mai più larga di così sugli schermi grandi */
  color: var(--wg-text);
  font-family:
    "Helvetica Neue",
    -apple-system,
    Helvetica,
    Arial,
    sans-serif;
}

.wordle__message {
  /* Altezza fissa, così la griglia non sobbalza quando il messaggio compare
     o sparisce. */
  min-height: 1.5rem;
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
}

/* === Cruscotto (livello / tempo / punteggio) ===
   Una fascia sola divisa in tre, con i numeri grandi e le etichette piccole.
   Fondino chiarissimo invece di tre riquadri bordati: pesa meno della griglia,
   che deve restare il centro della scena. */
.wordle__hud {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  width: 100%;
  border-radius: var(--wg-radius);
  background: var(--wg-surface);
  overflow: hidden;
}

.wordle__stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  padding: 0.6rem 0.4rem;
}

/* Separatore fra una voce e l'altra, tranne che prima della prima. */
.wordle__stat + .wordle__stat {
  box-shadow: inset 1px 0 0 var(--wg-border);
}

.wordle__stat-label {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--wg-dim);
}

/* Cifre a larghezza fissa: non ballano mentre il tempo scende. */
.wordle__stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: lining-nums tabular-nums;
}

/* Quando il tempo sta per scadere il riquadro si accende di rosso. */
.wordle__stat--urgent {
  background: #fdeceb;
}

.wordle__stat--urgent .wordle__stat-label,
.wordle__stat--urgent .wordle__stat-value {
  color: var(--wg-urgent);
}

.wordle__stat--urgent .wordle__stat-value {
  animation: wordle-pulse 1s ease-in-out infinite;
}

@keyframes wordle-pulse {
  50% {
    transform: scale(1.07);
  }
}

/* === Griglia === */
.wordle__board {
  display: grid;
  grid-template-rows: repeat(6, 1fr);
  gap: var(--wg-gap);
}

.wordle__row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--wg-gap);
}

.wordle__cell {
  display: flex;
  align-items: center;
  justify-content: center;
  /* Si restringe sui telefoni stretti, non supera mai 3.5rem sul computer. */
  width: clamp(2.5rem, 16vw, 3.5rem);
  height: clamp(2.5rem, 16vw, 3.5rem);
  border: 2px solid var(--wg-border);
  font-size: 2rem;
  font-weight: 700;
  line-height: 1;
  text-transform: uppercase;
  user-select: none;
}

/* Una cella scritta ma non ancora inviata: bordo più scuro e un guizzo, così
   si vede che la lettera è stata registrata. */
.wordle__cell--filled {
  border-color: var(--wg-border-filled);
  animation: wordle-pop-cell 0.1s ease-out;
}

@keyframes wordle-pop-cell {
  from {
    transform: scale(1.06);
  }
}

/* I tre colori dell'esito. */
.wordle__cell--correct {
  background: var(--wg-correct);
  border-color: var(--wg-correct);
  color: #ffffff;
}

.wordle__cell--present {
  background: var(--wg-present);
  border-color: var(--wg-present);
  color: #ffffff;
}

.wordle__cell--absent {
  background: var(--wg-absent);
  border-color: var(--wg-absent);
  color: #ffffff;
}

/* === Finestre modali: spiegazione e fine partita === */
.wordle__overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(26, 26, 26, 0.55);
  animation: wordle-fade 0.2s ease;
}

.wordle__result {
  position: relative; /* riferimento per la barra del tempo, ancorata in alto */
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  width: 100%;
  max-width: 24rem;
  max-height: 90vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 1.75rem 1.5rem 1.5rem;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  text-align: center;
  animation: wordle-pop 0.2s ease;
}

@keyframes wordle-fade {
  from {
    opacity: 0;
  }
}

@keyframes wordle-pop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.97);
  }
}

/* Barra del tempo di lettura, incollata al bordo alto della finestra: dice
   quanto manca senza costringere a leggere un numero mentre si legge altro. */
.wordle__progress {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 4px;
  background: var(--wg-border);
  border-radius: 8px 8px 0 0;
  overflow: hidden;
}

.wordle__progress-bar {
  height: 100%;
  background: var(--wg-correct);
  /* `linear` e non `ease`: il tempo scorre a velocità costante, e
     l'animazione deve dire la verità. */
  transition: width 1s linear;
}

/* Sopratitolo piccolo e spaziato: annuncia senza rubare la scena. */
.wordle__result-label {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--wg-dim);
}

/* Il lemma e il suo pulsante audio, sulla stessa riga. */
.wordle__headword {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  margin: -0.4rem 0 0;
}

/* La parola ha lo stesso trattamento delle lettere sulla griglia: stesso
   carattere, stesso peso, stesso spirito. È la stessa cosa, rivelata. */
.wordle__result-title {
  margin: 0;
  font-size: 2.1rem;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Il punteggio a fine partita: il numero risponde alla domanda che il
   giocatore si sta facendo, quindi è il pezzo grande della finestra. */
.wordle__result-score {
  margin: -0.5rem 0 -0.4rem;
  font-size: 3.2rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: lining-nums tabular-nums;
}

.wordle__result-stats {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--wg-dim);
}

.wordle__result-stats strong {
  color: var(--wg-text);
}

.wordle__result-text {
  margin: 0;
  font-size: 0.95rem;
  color: var(--wg-dim);
}

.wordle__result-text strong {
  color: var(--wg-text);
  letter-spacing: 0.05em;
}

/* === Voce di dizionario === */
.wordle__definition {
  margin: 0;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  text-wrap: pretty; /* evita che l'ultima riga resti con una parola sola */
}

/* Riga dei dati brevi sotto la parola: categoria · pronuncia · frequenza. */
.wordle__definition-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin: -0.4rem 0 0;
  font-size: 0.85rem;
  color: var(--wg-dim);
}

/* La pronuncia in carattere a larghezza fissa: i simboli fonetici hanno
   bisogno di spazio proprio per non impastarsi. */
.wordle__definition-ipa {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.82rem;
}

/* Frequenza: la stessa pastiglia colorata che il gioco usa per le lettere,
   così l'informazione "quanto è comune" parla il linguaggio del gioco. */
.wordle__definition-level {
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #ffffff;
  background: var(--wg-absent);
}

.wordle__definition-level--common {
  background: var(--wg-correct);
}

.wordle__definition-level--uncommon {
  background: var(--wg-present);
  color: #ffffff;
}

/* Pulsante della pronuncia: un tasto tondo dello stesso grigio della
   tastiera, così si riconosce subito come qualcosa da premere. */
.wordle__speak {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--wg-border);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.12s ease,
    transform 0.08s ease;
}

.wordle__speak:hover {
  background: var(--wg-border-filled);
}

.wordle__speak:active {
  transform: scale(0.92);
}

/* La definizione: è il testo che si legge davvero, quindi il più grande. */
.wordle__definition--en {
  padding-top: 0.9rem;
  border-top: 1px solid var(--wg-border);
  font-size: 1.05rem;
  line-height: 1.5;
}

/* La frase d'esempio: fondino chiaro e filetto verde a sinistra, lo stesso
   verde delle lettere azzeccate. */
.wordle__definition--example {
  padding: 0.7rem 0.85rem;
  border-left: 3px solid var(--wg-correct);
  border-radius: 0 var(--wg-radius) var(--wg-radius) 0;
  background: var(--wg-surface);
  font-size: 0.95rem;
  font-style: italic;
  line-height: 1.45;
  color: var(--wg-dim);
}

/* === Pulsanti === */
.wordle__again {
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.25rem;
  padding: 0.85rem 1.4rem;
  border: none;
  border-radius: var(--wg-radius);
  background: var(--wg-correct);
  color: #ffffff;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  cursor: pointer;
  transition: filter 0.12s ease;
}

.wordle__again:hover {
  filter: brightness(0.93);
}

.wordle__again:active {
  transform: translateY(1px);
}

/* === Modulo per il nome === */
.wordle__nickname {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding-top: 0.9rem;
  border-top: 1px solid var(--wg-border);
}

.wordle__nickname-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.wordle__nickname-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.65rem 0.7rem;
  border: 2px solid var(--wg-border);
  border-radius: var(--wg-radius);
  background: #ffffff;
  font: inherit;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-align: center;
  text-transform: uppercase;
  color: var(--wg-text);
}

.wordle__nickname-input:focus {
  outline: none;
  border-color: var(--wg-correct);
}

/* === Elenco della classifica === */
.wordle__scores {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.wordle__scores-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.45rem 0.6rem;
  border-radius: var(--wg-radius);
  background: var(--wg-surface);
  font-size: 0.95rem;
}

/* La riga appena salvata dal giocatore si distingue dalle altre. */
.wordle__scores-row--me {
  background: #e8f2e7;
  box-shadow: inset 0 0 0 2px var(--wg-correct);
}

.wordle__scores-rank {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5rem;
  height: 1.5rem;
  border-radius: 3px;
  font-size: 0.78rem;
  font-weight: 700;
  font-variant-numeric: lining-nums tabular-nums;
  color: #ffffff;
  background: var(--wg-absent);
}

/* Oro, argento e bronzo per i primi tre. */
.wordle__scores-row:nth-child(1) .wordle__scores-rank {
  background: #c9a227;
}
.wordle__scores-row:nth-child(2) .wordle__scores-rank {
  background: #8e949a;
}
.wordle__scores-row:nth-child(3) .wordle__scores-rank {
  background: #a9743f;
}

.wordle__scores-nick {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font-weight: 600;
}

.wordle__scores-score {
  font-variant-numeric: lining-nums tabular-nums;
  font-weight: 700;
}

/* === Tastiera a schermo === */
.wordle__keyboard {
  display: flex;
  flex-direction: column;
  gap: var(--wg-gap);
  width: 100%;
}

.wordle__keyboard-row {
  display: flex;
  justify-content: center;
  gap: var(--wg-gap);
}

.wordle__key {
  /* flex:1 = ogni tasto si divide in parti uguali la larghezza della riga,
     così la riga si adatta a qualsiasi schermo — è questo che rende la
     tastiera responsive. */
  flex: 1;
  min-width: 0;
  height: 3.5rem;
  border: none;
  border-radius: var(--wg-radius);
  background: var(--wg-border);
  color: var(--wg-text);
  font: inherit;
  font-size: 0.95rem;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    filter 0.12s ease,
    transform 0.06s ease;
}

/* Invio e Cancella occupano un po' più spazio di una singola lettera. */
.wordle__key--wide {
  flex: 1.5;
  font-size: 0.72rem;
  letter-spacing: 0.05em;
}

.wordle__key:hover {
  filter: brightness(0.94);
}

/* Il tasto si abbassa appena quando lo premi: la tastiera risponde al tocco. */
.wordle__key:active {
  transform: translateY(1px);
}

/* Colori delle lettere già usate, stessa tavolozza della griglia. */
.wordle__key--correct {
  background: var(--wg-correct);
  color: #ffffff;
}

.wordle__key--present {
  background: var(--wg-present);
  color: #ffffff;
}

.wordle__key--absent {
  background: var(--wg-absent);
  color: #ffffff;
}

/* Etichetta del tasto Invio: di norma la parola, col simbolo "⏎" nascosto. */
.wordle__key-icon {
  display: none;
}

/* Sugli schermi stretti la parola "Enter" viene sostituita dal simbolo "⏎",
   più compatto, così l'etichetta non esce mai dal suo tasto. */
@media (max-width: 430px) {
  .wordle__key-text {
    display: none;
  }
  .wordle__key-icon {
    display: inline;
    font-size: 1rem;
  }
}
</style>
