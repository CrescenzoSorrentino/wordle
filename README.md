# Wordle Arcade

An arcade twist on Wordle: the classic five-letter word game, turned into an
**endless, time-pressured run** with a global leaderboard — and a dictionary
entry after every word, so a run also teaches you vocabulary.

🎮 **Live demo:** https://wordle-rho-wheat.vercel.app

## How to play

- Guess the hidden five-letter English word in six tries. Each letter is marked
  **🟩 green** (right spot), **🟨 yellow** (in the word, wrong spot) or
  **⬜ grey** (not in the word).
- Solve a word to **advance a level**, bank points, and get a fresh word.
- Every level has a **countdown timer**. It starts at 5 minutes and shrinks each
  level (exponential decay toward a 30-second floor), so the pressure keeps
  building. Time left over carries into the next level, capped at 5 minutes.
- Each guess **rewards time** for its useful letters — +10s per new green, +5s
  per new yellow — but only the *first* time you discover each one, so you can't
  farm time by re-typing the same letters. A guess that reveals nothing costs 5s.
- Whatever the outcome, the word is then **explained**: part of speech, IPA
  pronunciation with a button that speaks it aloud, a frequency label, a
  definition and an example sentence. The clock and the keyboard are frozen
  while you read; a **Continue** button skips the remaining seconds.
- The run ends when you run out of guesses **or** run out of time. If your score
  makes the top 10, you're prompted for a nickname and added to the leaderboard.

## Scoring

Per solved word: `(10 + unusedAttempts * 5) * level` — faster solves and higher
levels are worth more.

## Tech

- **Nuxt 4** / **Vue 3** (`<script setup>`), vanilla scoped CSS (BEM).
- **Upstash Redis** for the leaderboard, stored as a sorted set (`ZADD` / `ZRANGE`).
- Pure game rules live in `shared/` (imported via the `#shared` alias) and are
  reused on the client and re-validated on the server.
- Pronunciation uses the browser's built-in `speechSynthesis` — no audio files
  and no network call. A named preference list picks a real English voice, since
  macOS ships novelty voices (Zarvox, Boing…) that also declare themselves
  `en-US`.
- The dictionary (~440 KB) is **never sent to the browser**. It is imported only
  by a server route, and the game fetches one entry at a time — at the *start*
  of each level, so the request has finished long before the entry is shown.

```
app/components/WordleGame.vue   the game (state, board, keyboard, timer, UI)
shared/wordle.ts                pure rules: evaluate, validate, timer formula
shared/words/                   the official guess + answer word lists
shared/definitions.ts           dictionary lookup, with a never-throwing fallback
shared/words/definitions.ts     2,315 generated entries (do not edit by hand)
shared/leaderboard.ts           leaderboard rules shared by client and server
server/api/definition.get.ts    one dictionary entry, by word
server/api/leaderboard.get.ts   read the top 10
server/api/leaderboard.post.ts  save a score
scripts/                        dictionary generation + validation (see below)
```

## Local development

Requires Node 20+ and an [Upstash Redis](https://console.upstash.com) database
(the free tier is plenty).

```bash
npm install
cp .env.example .env      # then fill in your Upstash REST URL + token
npm run dev               # http://localhost:3000
```

Environment variables (see `.env.example`):

| Variable | Description |
| --- | --- |
| `NUXT_UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `NUXT_UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `ANTHROPIC_API_KEY` | Only to regenerate the dictionary — the app never uses it |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |

## The dictionary

`shared/words/definitions.ts` holds one entry per answer word — part of speech,
IPA, frequency label, definition and example sentence. It is generated, not
hand-written, so that all 2,315 entries come out of a single prompt and stay
consistent with each other.

```bash
node --env-file=.env scripts/generate-definitions.mjs   # generate what's missing
node scripts/build-definitions.mjs                      # assemble + validate
```

- **Generation** needs `ANTHROPIC_API_KEY` in `.env`. It asks for 50 words per
  request, four requests at a time, and constrains the reply with a JSON schema
  so the response cannot arrive as prose. Re-running it is safe and cheap: it
  only asks for words that are still missing, so an interrupted run resumes
  where it stopped and nothing is paid for twice.
- **Validation** is a separate step on purpose. It checks coverage against the
  answer list, duplicates, unknown parts of speech, IPA wrapped in slashes, and
  that every example sentence actually uses its word. Irregular verbs
  (`cling` → *clung*) trip the last check and are false positives — the warning
  says so.
- Intermediate JSON blocks live in `scripts/.cache/` and are git-ignored; they
  can be regenerated at any time.

## Deployment

Deploys as a standard Nuxt app (e.g. Vercel). Set the two `NUXT_*` environment
variables in the host's dashboard — the local `.env` is not uploaded — and
redeploy so they take effect.

## Notes

- No accounts: the leaderboard keeps only the top 10 and trims the rest.
- The client-reported score is trusted (no anti-cheat), which is fine for a
  casual arcade game.
- Everything the player reads is in English, so the game isn't limited to one
  audience. Code comments are in Italian — different readers, different language.
- The dictionary was written by Claude and reviewed by sampling, not entry by
  entry. Expect the odd imprecise IPA transcription; the 🔊 button is the
  authoritative pronunciation.

## License

[MIT](./LICENSE) © Crescenzo Sorrentino
