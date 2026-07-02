<script setup lang="ts">
/**
 * WordleGame — classic Wordle (step 1). UI + local game state only; the rules
 * live in #shared/wordle. We are building this file up block by block.
 */
import {
  MAX_ATTEMPTS,
  WORD_LENGTH,
  evaluateGuess,
  isValidWord,
  pickRandomAnswer,
  timeForLevel,
  TIME_BONUS_CORRECT,
  TIME_BONUS_PRESENT,
  type LetterState,
} from "#shared/wordle";
import {
  LEADERBOARD_SIZE,
  NICKNAME_MAX_LENGTH,
  isValidNickname,
  sanitizeNickname,
  type LeaderboardEntry,
} from "#shared/leaderboard";

// The run is either in progress, or over (the player failed a word).
type GameStatus = "playing" | "lost";

// On-screen keyboard layout. "enter" and "back" are the two action keys.
const KEYBOARD_ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["enter", "z", "x", "c", "v", "b", "n", "m", "back"],
];

// === Game state (reactive: the screen follows these automatically) ===

const answer = ref(""); // the secret word for this game
const guesses = ref<string[]>([]); // guesses already submitted, lower-case
const evaluations = ref<LetterState[][]>([]); // one row of colours per guess
const currentGuess = ref(""); // the word currently being typed
const status = ref<GameStatus>("playing"); // playing / won / lost
const level = ref(1); // current level, starts at 1
const score = ref(0); // points accumulated this run
const timeLeft = ref(0); // seconds remaining on the current word
const message = ref(""); // short-lived feedback ("Not in word list", "Splendid!")

// Leaderboard state (filled in once the run ends).
const leaderboard = ref<LeaderboardEntry[]>([]); // current top scores
const qualifies = ref(false); // did this run make the top 10?
const nick = ref(""); // nickname being typed into the prompt
const scoreSubmitted = ref(false); // already saved this run's score?

let messageTimer: ReturnType<typeof setTimeout> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

// Which discoveries were already rewarded with time, so the same green/yellow
// can't be farmed by re-submitting it. Reset for every new word.
let rewardedGreens = new Set<number>(); // green positions already rewarded
let rewardedYellows = new Set<string>(); // present letters already rewarded

// === Derived data ===

/**
 * Best-known state for every letter the player has used, so the on-screen
 * keyboard can be coloured. Priority: correct > present > absent — once a
 * letter is green it must never visually downgrade to yellow.
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
      // Keep this letter's colour only if the new one ranks higher.
      if (map[letter] === undefined || rank[next] > rank[map[letter]!]) {
        map[letter] = next;
      }
    }
  });

  return map;
});

/** timeLeft (e.g. 187) formatted as minutes:seconds (e.g. "3:07"). */
const timeDisplay = computed(() => {
  const minutes = Math.floor(timeLeft.value / 60);
  const seconds = timeLeft.value % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
});

/**
 * The board as a ready-to-draw 6 x 5 grid. Each cell already knows its letter
 * and its visual state, so the template just paints it without deciding whether
 * a row is submitted / active / empty. Recomputes automatically whenever the
 * state above changes.
 */
const board = computed(() => {
  const rows: { letter: string; state: LetterState | "empty" | "filled" }[][] =
    [];

  for (let r = 0; r < MAX_ATTEMPTS; r++) {
    const cells: { letter: string; state: LetterState | "empty" | "filled" }[] =
      [];

    // Is row r already submitted? Is it the one being typed right now?
    const submitted = r < guesses.value.length;
    const isActiveRow =
      r === guesses.value.length && status.value === "playing";

    for (let c = 0; c < WORD_LENGTH; c++) {
      if (submitted) {
        // A confirmed guess: take its letter and its evaluated colour.
        cells.push({
          letter: guesses.value[r]![c]!,
          state: evaluations.value[r]![c]!,
        });
      } else if (isActiveRow && c < currentGuess.value.length) {
        // The active row, only as far as the player has typed.
        cells.push({ letter: currentGuess.value[c]!, state: "filled" });
      } else {
        // Anything else is still an empty cell.
        cells.push({ letter: "", state: "empty" });
      }
    }

    rows.push(cells);
  }

  return rows;
});

// === Actions: the functions that change the state ===

/** Adds a typed letter to the active row, if there is room and we're playing. */
function addLetter(letter: string) {
  if (status.value !== "playing") return;
  if (currentGuess.value.length >= WORD_LENGTH) return;
  currentGuess.value += letter;
}

/** Removes the last letter from the active row. */
function removeLetter() {
  if (status.value !== "playing") return;
  currentGuess.value = currentGuess.value.slice(0, -1);
}

/** Shows a short-lived message that clears itself after a moment. */
function flashMessage(text: string) {
  message.value = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message.value = "";
  }, 1600);
}

/** Stops the countdown (if any is running). */
function stopTimer() {
  clearInterval(countdownTimer);
  countdownTimer = undefined;
}

/** Ends the run: stop the clock, show Game Over, and check the leaderboard. */
function endRun() {
  stopTimer();
  status.value = "lost";
  finishRun();
}

/**
 * After a run ends: fetch the current top scores and decide whether this run's
 * score earns a spot (board not full yet, or beats the lowest top score). A
 * zero score never qualifies. Network errors fail soft (no prompt, empty list).
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

/** Saves the typed nickname with this run's score, then refreshes the board. */
async function submitScore() {
  if (!isValidNickname(nick.value)) return;
  try {
    await $fetch("/api/leaderboard", {
      method: "POST",
      body: { nick: sanitizeNickname(nick.value), score: score.value },
    });
    scoreSubmitted.value = true;
    qualifies.value = false; // hide the prompt
    leaderboard.value = await $fetch<LeaderboardEntry[]>("/api/leaderboard");
  } catch (e) {
    console.error("Could not submit score:", e);
  }
}

/**
 * Resets the clock to this level's time budget and starts ticking down once a
 * second. When it reaches zero the run is over.
 */
function startTimer() {
  stopTimer(); // never let two countdowns run at once
  timeLeft.value = timeForLevel(level.value);
  countdownTimer = setInterval(() => {
    timeLeft.value--;
    if (timeLeft.value <= 0) {
      endRun();
    }
  }, 1000);
}

/** Validates and submits the active row as a guess. */
function submitGuess() {
  if (status.value !== "playing") return;

  // Two reasons a guess can be rejected, each with its own message.
  if (currentGuess.value.length < WORD_LENGTH) {
    flashMessage("Not enough letters");
    return;
  }
  if (!isValidWord(currentGuess.value)) {
    flashMessage("Not in word list");
    return;
  }

  // Accepted: evaluate it and record both the word and its colours.
  const guess = currentGuess.value;
  const states = evaluateGuess(guess, answer.value);
  guesses.value.push(guess);
  evaluations.value.push(states);
  currentGuess.value = "";

  // Reward time only for NEW discoveries, so a letter can't be farmed.
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
  }

  // Solved: bank the points (before nextLevel resets the board) and level up.
  // Out of attempts: the run is over.
  if (guess === answer.value) {
    score.value += wordScore();
    nextLevel();
  } else if (guesses.value.length >= MAX_ATTEMPTS) {
    endRun();
  }
}

/** Loads a fresh word and clears the board for a new round (same run). */
function loadWord() {
  answer.value = pickRandomAnswer();
  guesses.value = [];
  evaluations.value = [];
  currentGuess.value = "";
  status.value = "playing";
  rewardedGreens = new Set(); // new word → nothing rewarded yet
  rewardedYellows = new Set();
  startTimer(); // fresh, shorter time budget for this level
}

/** Starts a brand-new run from level 1 with a zero score. */
function newRun() {
  level.value = 1;
  score.value = 0;
  qualifies.value = false;
  scoreSubmitted.value = false;
  nick.value = "";
  loadWord();
}

/** Player solved the word: go up one level and load the next word. */
function nextLevel() {
  level.value++;
  flashMessage(`Level ${level.value}!`);
  loadWord();
}

/** Points for solving the current word: faster solves and higher levels pay more. */
function wordScore(): number {
  const unused = MAX_ATTEMPTS - guesses.value.length;
  return (10 + unused * 5) * level.value;
}

/**
 * Single entry point for any key, from either keyboard. The "key" is one of:
 * "enter", "back", or a single letter a–z.
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

/** Translates a physical key press into our key tokens, then routes it. */
function onPhysicalKey(event: KeyboardEvent) {
  // Ignore shortcuts (Cmd/Ctrl/Alt combos) so we don't hijack copy, refresh…
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === "Enter") {
    handleKey("enter");
  } else if (event.key === "Backspace") {
    handleKey("back");
  } else {
    handleKey(event.key.toLowerCase());
  }
}

// Start the first game and begin listening to the keyboard when the component
// appears on screen; stop listening when it goes away (tidy-up).
onMounted(() => {
  newRun();
  window.addEventListener("keydown", onPhysicalKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onPhysicalKey);
  stopTimer();
});
</script>

<template>
  <section class="wordle" aria-label="Wordle game">
    <div class="wordle__hud">
      <span class="wordle__hud-item">Level {{ level }}</span>
      <span class="wordle__hud-item wordle__hud-item--time">{{
        timeDisplay
      }}</span>
      <span class="wordle__hud-item">Score {{ score }}</span>
    </div>

    <!-- Short-lived feedback. aria-live lets screen readers announce it. -->
    <p class="wordle__message" role="status" aria-live="polite">
      {{ message }}
    </p>

    <div class="wordle__board">
      <!-- One row per entry in `board` (6 rows). -->
      <div v-for="(row, rowIndex) in board" :key="rowIndex" class="wordle__row">
        <!-- One cell per letter in that row (5 cells). -->
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

    <!-- Game Over screen: only rendered once the run has ended. -->
    <div
      v-if="status === 'lost'"
      class="wordle__result"
      role="status"
      aria-live="polite"
    >
      <p class="wordle__result-title">Game Over</p>
      <p class="wordle__result-text">
        The word was <strong>{{ answer.toUpperCase() }}</strong
        >.
      </p>
      <p class="wordle__result-stats">
        Level reached <strong>{{ level }}</strong> · Score
        <strong>{{ score }}</strong>
      </p>

      <!-- Nickname prompt: only when the score made the top 10, not yet saved. -->
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

      <!-- The leaderboard itself. -->
      <ol v-if="leaderboard.length" class="wordle__scores">
        <li
          v-for="(entry, i) in leaderboard"
          :key="i"
          class="wordle__scores-row"
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

    <!-- On-screen keyboard: the only way to type on a touch device. -->
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
  /* Palette in one place: change a colour here, it updates everywhere. */
  --wg-gap: 5px;
  --wg-radius: 4px;
  --wg-border: #d3d6da;
  --wg-border-filled: #878a8c;
  --wg-text: #1a1a1a;
  --wg-key-bg: #d3d6da;
  --wg-correct: #6aaa64;
  --wg-present: #c9b458;
  --wg-absent: #787c7e;

  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  width: 100%;
  max-width: 30rem; /* never wider than this on big screens */
  color: var(--wg-text);
}

.wordle__message {
  /* Fixed height so the board doesn't jump when the message appears/clears. */
  min-height: 1.5rem;
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

/* === HUD (level / score bar) === */
.wordle__hud {
  display: flex;
  justify-content: space-between;
  width: 100%;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.wordle__hud-item {
  text-transform: uppercase;
}

.wordle__hud-item--time {
  /* tabular-nums keeps the digits from shifting width as they count down */
  font-variant-numeric: tabular-nums;
  font-size: 1.15rem;
}

/* === Board === */
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
  /* Shrinks on narrow phones, never grows past 3.5rem on desktop. */
  width: clamp(2.5rem, 16vw, 3.5rem);
  height: clamp(2.5rem, 16vw, 3.5rem);
  border: 2px solid var(--wg-border);
  border-radius: var(--wg-radius);
  font-size: 1.75rem;
  font-weight: 700;
  text-transform: uppercase;
  user-select: none;
}

/* An empty cell keeps the default light border (nothing extra needed). */

/* A typed-but-not-submitted cell gets a darker border. */
.wordle__cell--filled {
  border-color: var(--wg-border-filled);
}

/* The three result colours. */
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

/* === Result banner === */
.wordle__result {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  text-align: center;
}

.wordle__result-title {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.wordle__result-text {
  margin: 0;
  font-size: 1.05rem;
}

.wordle__result-stats {
  margin: 0;
  font-size: 1rem;
}

.wordle__again {
  font: inherit;
  font-weight: 600;
  padding: 0.6rem 1.4rem;
  border: none;
  border-radius: var(--wg-radius);
  background: var(--wg-correct);
  color: #ffffff;
  cursor: pointer;
}

.wordle__again:hover {
  filter: brightness(0.95);
}

/* === Nickname prompt === */
.wordle__nickname {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
}

.wordle__nickname-label {
  font-size: 0.95rem;
  font-weight: 600;
}

.wordle__nickname-input {
  font: inherit;
  text-align: center;
  padding: 0.5rem 0.7rem;
  border: 2px solid var(--wg-border-filled);
  border-radius: var(--wg-radius);
  width: 12rem;
  max-width: 100%;
}

.wordle__nickname-input:focus {
  outline: 2px solid var(--wg-correct);
  outline-offset: 1px;
}

/* === Leaderboard list === */
.wordle__scores {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wordle__scores-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.35rem 0.6rem;
  background: #f4f4f5;
  border-radius: var(--wg-radius);
  font-size: 0.95rem;
}

.wordle__scores-rank {
  min-width: 1.5rem;
  font-weight: 700;
  color: var(--wg-absent);
}

.wordle__scores-nick {
  flex: 1;
  text-align: left;
  font-weight: 600;
}

.wordle__scores-score {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

/* === On-screen keyboard === */
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
  /* flex:1 = every key shares the row width equally, so the row fits any
     screen size — this is what makes the keyboard responsive. */
  flex: 1;
  min-width: 0;
  height: 3.5rem;
  border: none;
  border-radius: var(--wg-radius);
  background: var(--wg-key-bg);
  color: var(--wg-text);
  font: inherit;
  font-weight: 600;
  text-transform: uppercase;
  cursor: pointer;
}

/* Enter / Backspace take a bit more room than a single letter. */
.wordle__key--wide {
  flex: 1.5;
  font-size: 0.75rem;
}

.wordle__key:hover {
  filter: brightness(0.95);
}

/* Used-letter colours, same palette as the board. */
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

/* Enter key label: word by default, "⏎" symbol hidden. */
.wordle__key-icon {
  display: none;
}

/* On narrow screens swap the word "Enter" for the compact "⏎" symbol so the
   label never overflows its key. */
@media (max-width: 430px) {
  .wordle__key-text {
    display: none;
  }
  .wordle__key-icon {
    display: inline;
  }
}
</style>
