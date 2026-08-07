# Wordpace

A five-letter word game turned into an **endless, time-pressured run** with a
global leaderboard — and a dictionary entry after every word, so a run also
teaches you vocabulary.

Inspired by the classic five-letter guessing game. Not affiliated with, or
endorsed by, The New York Times.

🎮 **Play it:** https://wordpace.vercel.app

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
  makes the top 10 **of the current month**, you're prompted for a nickname and
  added to the leaderboard. The board starts fresh on the first of every month,
  so a good run is never locked out by scores set long ago.

## When you're stuck

Once you've made **3 guesses** — or the clock drops under **45 seconds** — a
**Hint** button appears. Everything behind it is paid for in points, and the
clock keeps running while the panel is open: being stuck is meant to cost
something.

**Hints** reveal a bit of the word and stay readable for the rest of it. Prices
are per level (`cost × level`), because the points a word is worth grow with the
level too:

| Hint | Reveals | Price |
| --- | --- | --- |
| Letter | One letter of the word you haven't tried yet | 3 × level |
| Sentence | The example sentence, with the word blanked out | 6 × level |
| Definition | What the word means | 12 × level |

**Skips** give up on the word entirely — you get a new one, and you never find
out what it was worth. You get **3 per run**, and each one costs more than the
last: `10 × level × 2^(skips already used)`. At level 3, where a solved word is
worth around 60 points, that's 30, then 60, then 120.

A skip deliberately gives you *nothing* back: the level stays the same, no fresh
seconds are granted, and the abandoned word scores zero. It buys you a word you
might actually know — not more time.

## Scoring

Per solved word: `(10 + unusedAttempts * 5) * level` — faster solves and higher
levels are worth more.

## Tech

- **Nuxt 4** / **Vue 3** (`<script setup>`), vanilla scoped CSS (BEM).
- **Upstash Redis** for the leaderboard, stored as a sorted set (`ZADD` / `ZRANGE`)
  under a per-month key (`wordle:leaderboard:2026-08`), so the board resets on
  its own and old months expire instead of piling up.
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
app/components/WordpaceGame.vue  the game (state, board, keyboard, timer, UI)
shared/wordle.ts                pure rules: evaluate, validate, timer formula
shared/words/                   the official guess + answer word lists
shared/definitions.ts           dictionary lookup, with a never-throwing fallback
shared/words/definitions.ts     2,315 generated entries (do not edit by hand)
shared/leaderboard.ts           leaderboard rules shared by client and server
server/utils/leaderboard.ts     the Redis key of the current month's board
server/api/definition.get.ts    one dictionary entry, by word
server/api/leaderboard.get.ts   read the top 10
server/api/leaderboard.post.ts  save a score (validated + rate limited)
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
- The score is still reported by the client, so it can be faked — the server
  only limits the damage: it rejects anything above a plausible ceiling, allows
  5 submissions per hour per address, and wipes the board monthly. A forged
  score is therefore beatable and temporary rather than permanent. Verifying it
  properly would mean replaying the run server-side, which is overkill here.
- Everything the player reads is in English, so the game isn't limited to one
  audience. Code comments are in Italian — different readers, different language.
- The dictionary was written by Claude and reviewed by sampling, not entry by
  entry. Expect the odd imprecise IPA transcription; the 🔊 button is the
  authoritative pronunciation.

## License

[MIT](./LICENSE) © Crescenzo Sorrentino
