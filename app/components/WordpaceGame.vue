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
  HINT_MIN_GUESSES,
  HINT_LOW_TIME,
  costForHint,
  pickUntriedLetter,
  maskWordInExample,
  MAX_SKIPS,
  costForSkip,
  type LetterState,
  type HintSize,
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
//
// "same-level" è la destinazione dello skip, e le altre due non andavano bene
// proprio per quello che NON deve succedere: parola nuova sì, ma senza salire
// di livello e senza i secondi che un livello nuovo regala.
type NextStep = "next-level" | "same-level" | "game-over";

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

/**
 * Perché l'ultimo salvataggio è fallito, o stringa vuota se non è fallito.
 *
 * Prima di questo il fallimento finiva solo nella console: il modulo restava
 * immobile e chi giocava non sapeva se il punteggio fosse stato salvato. Il
 * peggior esito possibile per un errore è che nessuno se ne accorga.
 */
const submitError = ref("");

let messageTimer: ReturnType<typeof setTimeout> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let explanationTimer: ReturnType<typeof setInterval> | undefined;

// Quali scoperte hanno già fruttato tempo, così lo stesso verde o giallo non
// può essere sfruttato di nuovo reinviandolo. Si azzerano a ogni nuova parola.
let rewardedGreens = new Set<number>(); // posizioni verdi già premiate
let rewardedYellows = new Set<string>(); // lettere gialle già premiate
/**
 * Gli aiuti comprati su QUESTA parola, ognuno col testo che ha rivelato.
 *
 * Un solo stato e non due (un elenco di comprati + un elenco di testi) perché
 * sarebbero due copie dello stesso fatto, da aggiornare e azzerare in coppia:
 * il giorno che se ne aggiorna una sola, il pulsante risulta spento senza che
 * compaia nulla, e il giocatore ha pagato per il vuoto.
 *
 * Reattivo, a differenza di rewardedGreens qui sopra, perché il pannello degli
 * aiuti lo legge per sapere cosa mostrare e quali pulsanti spegnere.
 */
const boughtHints = ref<{ size: HintSize; text: string }[]>([]);

/**
 * Quante parole sono già state abbandonate in QUESTA partita.
 *
 * Si contano quelli usati e non quelli rimasti perché è il numero che serve a
 * fare il prezzo: costForSkip rincara in base a quanti se ne sono già spesi.
 * Quanti ne restano è una sottrazione, e infatti è una computed.
 *
 * Lo azzera solo newRun: gli skip durano una partita intera, non una parola.
 * Rimetterlo a zero in loadWord ne regalerebbe tre a ogni livello.
 */
const skipsUsed = ref(0);

/**
 * Se la finestra degli aiuti è aperta.
 *
 * Il timer NON si ferma mentre è aperta, a differenza della spiegazione: lì il
 * giocatore ha già finito la parola, qui la sta ancora giocando. Fermarlo
 * regalerebbe tempo di riflessione gratis, e trasformerebbe la finestra in una
 * pausa strategica invece che in una scelta sotto pressione.
 */
const hintPanelOpen = ref(false);

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

/**
 * Se il pannello degli aiuti va mostrato. Due segnali di difficoltà diversi, e
 * ne basta uno: chi è bloccato dopo tre tentativi ha bisogno di aiuto quanto
 * chi sta per esaurire il tempo.
 *
 * Il controllo sulla fase non è pignoleria: senza, il pannello resterebbe
 * visibile sopra il Game Over (dove il tempo è a zero, quindi la seconda
 * condizione è vera) e accanto alla spiegazione dopo una parola risolta al
 * quinto tentativo — lasciando comprare un aiuto per una parola che il
 * giocatore non sta più giocando.
 */
/** Come si chiamano i tre aiuti a schermo. */
const HINT_LABELS: Record<HintSize, string> = {
  small: "Letter",
  medium: "Sentence",
  large: "Definition",
};

/**
 * I tre aiuti già pronti da disegnare: etichetta, prezzo al livello corrente,
 * se è già stato comprato e se il giocatore se lo può permettere.
 *
 * Come `board`, il template si limita a dipingere: qui c'è tutto ciò che serve
 * per decidere quali pulsanti spegnere, così l'HTML non deve fare conti.
 */
const hintOptions = computed(() =>
  (["small", "medium", "large"] as const).map((size) => {
    const cost = costForHint(size, level.value);
    return {
      size,
      cost,
      label: HINT_LABELS[size],
      bought: boughtHints.value.some((hint) => hint.size === size),
      affordable: score.value >= cost,
    };
  }),
);

/**
 * Se c'è almeno un aiuto che il giocatore può davvero comprare adesso: non
 * ancora preso, e alla sua portata. Serve ad accendere la lampadina.
 *
 * Non basta "ho abbastanza punti": avendo già comprato tutti e tre gli aiuti,
 * i punti non servono a nulla e la lampadina deve restare spenta.
 */
const canBuyAnyHint = computed(() =>
  hintOptions.value.some((option) => !option.bought && option.affordable),
);

const hintAvailable = computed(
  () =>
    status.value === "playing" &&
    (guesses.value.length >= HINT_MIN_GUESSES ||
      timeLeft.value <= HINT_LOW_TIME),
);

/** Quanti skip restano da spendere: va a schermo sotto il pulsante. */
const skipsLeft = computed(() => MAX_SKIPS - skipsUsed.value);

/**
 * Quanto costa lo skip in questo momento. Dipende dal livello e da quanti se
 * ne sono già usati, quindi cambia due volte: salendo di livello e appena se
 * ne compra uno. Da qui la regola d'ordine dentro skipWord.
 */
const skipCost = computed(() => costForSkip(level.value, skipsUsed.value));

/**
 * Se il giocatore può abbandonare la parola adesso. Tre condizioni, e servono
 * tutte: la finestra è sbloccata, gliene resta almeno uno, e ha i punti per
 * pagarlo.
 *
 * La prima riusa hintAvailable invece di riscriverne la condizione: skip e
 * aiuti passano dalla stessa porta, ed è voluto — potendo skippare al primo
 * tentativo, il gioco diventerebbe una caccia alla parola che piace.
 */
const canSkip = computed(
  () =>
    hintAvailable.value && skipsLeft.value > 0 && score.value >= skipCost.value,
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

/**
 * Il testo di un aiuto, oppure `undefined` se non c'è nulla da dare.
 *
 * Lo `switch` su HintSize non è una scelta stilistica: essendo un tipo a tre
 * valori, TypeScript sa che i casi sono esattamente tre e segnala se ne
 * aggiungiamo un quarto senza gestirlo qui. Con un `string` non potrebbe.
 */
function buildHintText(size: HintSize): string | undefined {
  const definition = currentDefinition.value;

  switch (size) {
    case "small": {
      const letter = pickUntriedLetter(answer.value, guesses.value);
      return letter
        ? `The word contains the letter “${letter.toUpperCase()}”.`
        : undefined;
    }
    case "medium":
      // La definizione arriva dal server: se non è ancora arrivata (o la parola
      // non ne ha una) i campi sono vuoti, e non c'è niente da vendere.
      return definition.example
        ? maskWordInExample(definition.example, answer.value)
        : undefined;
    case "large":
      return definition.en || undefined;
  }
}

/**
 * Compra un aiuto: scala i punti e ne registra il testo.
 *
 * L'ordine dei controlli è la parte importante. Il testo viene costruito PRIMA
 * di toccare il punteggio, così se non c'è nulla da rivelare — succede quando
 * il giocatore ha già provato tutte le lettere della parola — la funzione esce
 * senza far pagare. Scalando i punti per primi, avrebbe pagato per il vuoto.
 *
 * I tre controlli iniziali duplicano quello che l'interfaccia già impedisce
 * (pulsanti spenti). È voluto: l'interfaccia è una comodità per chi gioca, non
 * una garanzia — e queste sono le regole.
 */
function buyHint(size: HintSize) {
  if (!hintAvailable.value) return;
  if (boughtHints.value.some((hint) => hint.size === size)) return;

  const cost = costForHint(size, level.value);
  if (score.value < cost) return;

  const text = buildHintText(size);
  if (!text) return;

  score.value -= cost;
  boughtHints.value.push({ size, text });
}

/**
 * Abbandona la parola in corso: la paga in punti e passa alla successiva
 * restando sullo stesso livello.
 *
 * L'ordine delle due righe centrali è una regola, non un gusto: skipCost è
 * calcolato SU skipsUsed, quindi incrementando prima di pagare il prezzo
 * raddoppierebbe fra una riga e l'altra e il giocatore si vedrebbe addebitare
 * lo skip successivo invece di questo.
 *
 * Non ferma il timer e non cambia livello: al resto pensa startExplanation,
 * che spegne l'orologio e mostra la parola perduta. Il ritorno è affidato a
 * "same-level", l'unica destinazione che ricarica la parola senza far salire
 * di livello né regalare i secondi di uno nuovo.
 *
 * La guardia iniziale ripete quello che l'interfaccia già impedisce, come in
 * buyHint: i pulsanti spenti sono una cortesia, la regola sta qui.
 */
function skipWord() {
  if (!canSkip.value) return;
  score.value -= skipCost.value;
  skipsUsed.value++;
  startExplanation("same-level");
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
  } else if (nextStep.value === "same-level") {
    loadWord();
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
  submitError.value = ""; // un nuovo tentativo cancella l'esito del precedente
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

    // Il 429 merita un testo suo: è l'unico rifiuto che non si risolve
    // riprovando subito, e senza spiegarlo il giocatore ritenta all'infinito.
    // Non nomina il limite né il fatto che si conta per indirizzo: a chi ha
    // giocato onestamente non serve, e a chi sta provando a barare direbbe
    // esattamente quanto può osare.
    const status = (e as { statusCode?: number })?.statusCode;
    submitError.value =
      status === 429
        ? "Too many scores sent from here. Try again later."
        : "Could not save your score. Check your connection and try again.";
  }
}

/**
 * Fa scorrere l'orologio: un secondo in meno al secondo, e alla fine del tempo
 * la partita si chiude passando dalla spiegazione della parola.
 *
 * NON assegna tempo: quello lo fa grantLevelTime, ed è una funzione separata
 * apposta. Finché le due cose stavano insieme era impossibile rimettere in moto
 * l'orologio senza regalare anche i secondi di un livello — cioè esattamente
 * ciò che serve dopo uno skip, dove la parola cambia ma il livello no.
 */
function startCountdown() {
  stopTimer(); // mai due conti alla rovescia in funzione insieme
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
  boughtHints.value = [];
  hintPanelOpen.value = false;
  startCountdown(); // l'orologio riparte, ma col tempo che c'era già
}

/**
 * Accredita i secondi che spettano a questo livello.
 *
 * Si SOMMA a quelli rimasti invece di sostituirli, ed è la regola che rende
 * Wordpace una corsa unica e non sei partite separate: i secondi risparmiati
 * restano tuoi e ti terranno in vita più avanti, quando un livello ne regala
 * quaranta. Con un `=` al posto del `+` ogni livello ripartirebbe da capo e
 * andare veloci non varrebbe nulla.
 *
 * Math.min mette il tetto: chi vola nei primi livelli, che sono facili e
 * generosi, si ritroverebbe altrimenti con un vantaggio tale da non guardare
 * più l'orologio per il resto della partita.
 *
 * La chiamano newRun e nextLevel, cioè i due soli punti in cui un livello
 * comincia davvero. Lo skip no: cambia la parola, non il livello.
 */
function grantLevelTime() {
  timeLeft.value = Math.min(
    timeLeft.value + timeForLevel(level.value),
    MAX_TIME,
  );
}

/** Avvia una partita nuova dal livello 1 con punteggio azzerato. */
function newRun() {
  level.value = 1;
  score.value = 0;
  timeLeft.value = 0;
  qualifies.value = false;
  scoreSubmitted.value = false;
  nick.value = "";
  skipsUsed.value = 0;
  grantLevelTime();
  loadWord();
}

/** Parola indovinata: si sale di un livello e si carica la parola successiva. */
function nextLevel() {
  level.value++;
  flashMessage(`Level ${level.value}!`);
  grantLevelTime();
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

  // Con la finestra degli aiuti aperta la tastiera serve solo a chiuderla:
  // altrimenti si continuerebbe a scrivere su una griglia che non si vede.
  // Un controllo qui invece che in addLetter, removeLetter e submitGuess:
  // un punto solo da ricordare.
  if (hintPanelOpen.value) {
    if (event.key === "Escape") hintPanelOpen.value = false;
    return;
  }

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
watch([status, hintPanelOpen], ([current, hintsOpen]) => {
  const covered = current !== "playing" || hintsOpen;
  document.body.style.overflow = covered ? "hidden" : "";
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

    <!-- Riga di servizio: il messaggio al centro e, quando serve, il pulsante
         degli aiuti a destra. Il pulsante sta QUI e non sotto la griglia perché
         questa riga ha un'altezza fissa già riservata: comparendo non sposta
         nulla, mentre un pannello sotto la griglia spingeva giù la tastiera
         mentre il giocatore stava digitando. -->
    <div class="wordle__status-row">
      <!-- aria-live fa sì che i lettori di schermo annuncino il messaggio. -->
      <p class="wordle__message" role="status" aria-live="polite">
        {{ message }}
      </p>

      <button
        v-if="hintAvailable"
        class="wordle__hint-open"
        :class="{ 'wordle__hint-open--lit': canBuyAnyHint }"
        type="button"
        :aria-label="
          canBuyAnyHint ? 'Open hints — one is available' : 'Open hints'
        "
        @click="hintPanelOpen = true"
      >
        <!-- Icona disegnata qui e non un'emoji: un SVG eredita `currentColor`,
             quindi si spegne insieme al pulsante ed è identico su ogni sistema.
             Un'emoji la disegna il sistema operativo, sempre a colori pieni. -->
        <svg
          class="wordle__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            class="wordle__icon-bulb"
            d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"
          />
          <path d="M9.5 20h5" />
        </svg>
        Hint
      </button>
    </div>

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

    <!-- Aiuti: una finestra e non un pannello dentro la pagina. Su uno schermo
         da telefono il gioco occupa già tutta l'altezza disponibile, e un
         blocco che cresce a ogni acquisto spingeva la tastiera fuori schermo.
         Una finestra sopra il gioco non toglie spazio a nulla, e riusa un
         linguaggio che il giocatore conosce già (spiegazione, fine partita). -->
    <div v-if="hintPanelOpen" class="wordle__overlay">
      <div
        class="wordle__result"
        role="dialog"
        aria-modal="true"
        aria-label="Hints"
      >
        <p class="wordle__result-label">Need a hint?</p>
        <p class="wordle__hints-intro">
          Each one costs points. The clock keeps running.
        </p>

        <div class="wordle__hints-row">
          <button
            v-for="option in hintOptions"
            :key="option.size"
            class="wordle__hint"
            type="button"
            :disabled="option.bought || !option.affordable"
            :title="
              option.bought
                ? 'Already bought'
                : option.affordable
                  ? `Costs ${option.cost} points`
                  : 'Not enough points'
            "
            @click="buyHint(option.size)"
          >
            <span class="wordle__hint-label">{{ option.label }}</span>
            <span class="wordle__hint-cost">−{{ option.cost }}</span>
          </button>
        </div>

        <!-- Gli aiuti comprati restano per tutta la parola: sono stati pagati,
             e riaprire la finestra per rileggerli non deve costare un secondo
             acquisto. Ognuno porta il nome dell'aiuto da cui viene, altrimenti
             comprandone due non si capisce quale testo risponde a cosa. -->
        <div
          v-for="hint in boughtHints"
          :key="hint.size"
          class="wordle__hint-box"
        >
          <p class="wordle__hint-kind">{{ HINT_LABELS[hint.size] }}</p>
          <p class="wordle__hint-text">{{ hint.text }}</p>
        </div>

        <!-- Lo skip sta qui perché la domanda è la stessa degli aiuti ("sono
             bloccato, cosa posso fare?") e la moneta pure. Ma è staccato dai
             tre e in fondo, non in fila con loro: è l'unica scelta di questa
             finestra che non si può disfare, e un dito che sbaglia pulsante
             deve poter sbagliare solo fra tre acquisti innocui. -->
        <div class="wordle__skip">
          <button
            class="wordle__skip-button"
            type="button"
            :disabled="!canSkip"
            :title="
              skipsLeft === 0
                ? 'No skips left in this run'
                : canSkip
                  ? `Costs ${skipCost} points — the word is lost`
                  : 'Not enough points'
            "
            @click="skipWord"
          >
            <span class="wordle__skip-label">Skip this word</span>
            <span class="wordle__skip-cost">−{{ skipCost }}</span>
          </button>

          <!-- Il prezzo da solo non basta a decidere: senza sapere quanti ne
               restano, il giocatore non può capire se conviene spenderlo ora o
               tenerlo per un livello più avanti, quando le parole sono più
               dure. E il rincaro del prossimo si legge già qui. -->
          <p class="wordle__skip-note">
            {{ skipsLeft === 1 ? "1 skip left" : `${skipsLeft} skips left` }} in
            this run · no points for a skipped word
          </p>
        </div>

        <button
          class="wordle__again"
          type="button"
          @click="hintPanelOpen = false"
        >
          Back to the game
        </button>
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
            <svg
              class="wordle__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              <path d="M19 5a9 9 0 0 1 0 14" />
            </svg>
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
            Top {{ LEADERBOARD_SIZE }} this month! Enter your name:
          </label>
          <input
            id="nick"
            class="wordle__nickname-input"
            v-model="nick"
            :maxlength="NICKNAME_MAX_LENGTH"
            autocomplete="off"
          />
          <button class="wordle__again" type="submit">Save</button>

          <!-- role="alert" non è decorativo: fa annunciare il messaggio dai
               lettori di schermo appena compare. Chi non vede il modulo si
               accorgerebbe altrimenti solo del fatto che non succede nulla. -->
          <p v-if="submitError" class="wordle__nickname-error" role="alert">
            {{ submitError }}
          </p>
        </form>

        <!-- La classifica vera e propria. Il titolo dice "this month" perché
             la lista riparte da zero ogni mese: senza, chi vede dieci punteggi
             più alti del suo pensa di essere fuori per sempre, invece che fino
             al primo del mese. È anche l'unico posto in cui il giocatore può
             accorgersi che esiste una scadenza. -->
        <p v-if="leaderboard.length" class="wordle__scores-title">
          Best this month
        </p>
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

/* Riga di servizio: messaggio al centro, pulsante degli aiuti a destra.
   Il pulsante è posizionato in assoluto e non in fila, così comparendo non
   sposta il messaggio di un pixel — e la riga mantiene la stessa altezza con
   o senza di lui. */
.wordle__status-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 2rem;
}

.wordle__message {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
}

/* Le icone disegnate nella pagina. `currentColor` fa sì che prendano il colore
   del testo del pulsante che le contiene: si spengono quando lui si spegne,
   si scuriscono quando lui si scurisce. Un'emoji resterebbe accesa. */
.wordle__icon {
  width: 1.05em;
  height: 1.05em;
  flex-shrink: 0; /* non si schiaccia se lo spazio è poco */
}

.wordle__hint-open {
  position: absolute;
  right: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.6rem;
  border: none;
  border-radius: var(--wg-radius);
  background: var(--wg-border);
  color: var(--wg-text);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  animation: wordle-hints-in 0.2s ease;
}

.wordle__hint-open:hover {
  filter: brightness(0.94);
}

/* Lampadina accesa = c'è almeno un aiuto comprabile adesso. È l'unica
   informazione che il giocatore non potrebbe avere senza aprire la finestra,
   quindi vale la pena darla qui.
   Il giallo qui non confligge con quello della griglia: dentro una lampadina
   si legge come "accesa", non come "lettera fuori posto". */
.wordle__icon-bulb {
  fill: none;
  transition: fill 0.25s ease;
}

.wordle__hint-open--lit .wordle__icon-bulb {
  fill: var(--wg-present);
}

.wordle__hint-open:active {
  transform: translateY(1px);
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

/* === Pannello degli aiuti ===
   Sta fra la griglia e la tastiera e usa il linguaggio della tastiera (tasti
   grigi, stessi angoli): è un'azione, non un contenuto, e deve leggersi come
   tale. */
@keyframes wordle-hints-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

/* Avverte che il tempo continua a scorrere: senza, il giocatore potrebbe
   credere che la finestra metta in pausa, come fa quella della spiegazione. */
.wordle__hints-intro {
  margin: -0.4rem 0 0.2rem;
  font-size: 0.85rem;
  color: var(--wg-dim);
}

/* Tre colonne di uguale larghezza: su qualsiasi schermo i pulsanti restano
   allineati su una riga sola, invece di andare a capo in modo irregolare. */
.wordle__hints-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--wg-gap);
  width: 100%;
}

.wordle__hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  min-width: 0;
  padding: 0.5rem 0.3rem;
  border: none;
  border-radius: var(--wg-radius);
  background: var(--wg-border);
  color: var(--wg-text);
  font: inherit;
  cursor: pointer;
  transition: filter 0.12s ease;
}

.wordle__hint:hover:not(:disabled) {
  filter: brightness(0.94);
}

.wordle__hint:active:not(:disabled) {
  transform: translateY(1px);
}

/* Speso o non permesso: resta leggibile ma chiaramente inattivo. Il prezzo
   continua a vedersi, perché è l'informazione che spiega il perché. */
.wordle__hint:disabled {
  background: var(--wg-surface);
  color: var(--wg-dim);
  cursor: not-allowed;
}

.wordle__hint-label {
  font-size: 0.78rem;
  font-weight: 700;
}

.wordle__hint-cost {
  font-size: 0.7rem;
  font-weight: 700;
  font-variant-numeric: lining-nums tabular-nums;
  opacity: 0.7;
}

/* L'aiuto comprato. Nessun filetto colorato: nel gioco verde e giallo hanno un
   significato preciso (lettera giusta, lettera fuori posto), e usarli qui come
   decorazione presterebbe a un testo un significato che non ha. Un fondino
   neutro e un'etichetta dicono di più senza rubare nulla alla tavolozza. */
.wordle__hint-box {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.7rem;
  border-radius: var(--wg-radius);
  background: var(--wg-surface);
  text-align: left;
}

/* Da quale dei tre aiuti viene questo testo: comprandone due, senza questa
   riga non si capirebbe più quale risponde a cosa. */
.wordle__hint-kind {
  margin: 0 0 0.15rem;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--wg-dim);
}

.wordle__hint-text {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.4;
}

/* Il filetto in cima è la separazione vera fra "compro un aiuto" e "abbandono
   la parola": sono due categorie di scelta diverse, e senza una riga che le
   divida lo skip sembrerebbe il quarto acquisto della fila. */
.wordle__skip {
  width: 100%;
  padding-top: 0.7rem;
  border-top: 1px solid var(--wg-border);
}

/* Largo tutta la finestra, al contrario dei tre aiuti che stanno in colonne
   strette: la larghezza diversa dice da sola che non è uno di loro.

   Solo contorno e nessun fondo, mentre gli aiuti sono pieni: è la coppia
   "azione principale / azione secondaria" che si vede ovunque, e qui dice la
   cosa giusta — la via normale quando sei bloccato è comprare un aiuto e
   risolvere, abbandonare la parola è il ripiego.

   Il fondo trasparente non è un dettaglio: con un fondino chiaro lo skip
   diventava indistinguibile dagli aiuti SPENTI, che passano anche loro a
   --wg-surface. Ed è lo stato in cui li trova chiunque inizi una partita, a
   punti zero. */
.wordle__skip-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--wg-border-filled);
  border-radius: var(--wg-radius);
  background: transparent;
  color: var(--wg-text);
  font: inherit;
  cursor: pointer;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}

/* Il fondo compare solo al passaggio del mouse. Con lo sfondo trasparente non
   c'è niente da scurire con un filtro, come si fa per gli aiuti: qui la
   reazione al mouse deve essere il fondo stesso. */
.wordle__skip-button:hover:not(:disabled) {
  background: var(--wg-surface);
  border-color: var(--wg-text);
}

.wordle__skip-button:active:not(:disabled) {
  transform: translateY(1px);
}

/* Come per gli aiuti: spento ma leggibile, e il prezzo resta in vista perché
   di solito è proprio lui la spiegazione del perché è spento. Anche il
   contorno si schiarisce: un pulsante inattivo non può avere il bordo più
   marcato di quelli attivi lì accanto. */
.wordle__skip-button:disabled {
  border-color: var(--wg-border);
  color: var(--wg-dim);
  cursor: not-allowed;
}

.wordle__skip-label {
  font-size: 0.85rem;
  font-weight: 700;
}

.wordle__skip-cost {
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: lining-nums tabular-nums;
  opacity: 0.7;
}

.wordle__skip-note {
  margin: 0.35rem 0 0;
  font-size: 0.72rem;
  line-height: 1.35;
  color: var(--wg-dim);
  text-align: center;
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

/* Il rosso qui è lecito, a differenza che sulla griglia: --wg-urgent è già il
   colore del tempo che sta per finire, cioè "qualcosa non va", e un messaggio
   di errore dice la stessa cosa. Non ruba significato a verde e giallo, che
   sono i colori delle lettere. */
.wordle__nickname-error {
  margin: -0.2rem 0 0;
  font-size: 0.8rem;
  line-height: 1.35;
  color: var(--wg-urgent);
  text-align: center;
}

/* === Elenco della classifica === */
/* Stesso trattamento delle altre etichettine del gioco (la riga sopra gli aiuti
   comprati): maiuscoletto spaziato e colore attenuato, così intitola la lista
   senza competere coi punteggi. */
.wordle__scores-title {
  margin: -0.4rem 0 0;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--wg-dim);
}

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
