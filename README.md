# Wordle Arcade

An arcade twist on Wordle: the classic five-letter word game, turned into an
**endless, time-pressured run** with a global leaderboard.

🎮 **Live demo:** https://wordle-rho-wheat.vercel.app

## How to play

- Guess the hidden five-letter English word in six tries. Each letter is marked
  **🟩 green** (right spot), **🟨 yellow** (in the word, wrong spot) or
  **⬜ grey** (not in the word).
- Solve a word to **advance a level**, bank points, and get a fresh word.
- Every level has a **countdown timer**. It starts at 5 minutes and shrinks each
  level (exponential decay toward a 20-second floor), so the pressure keeps
  building.
- Each guess **rewards time** for its useful letters — +10s per new green, +5s
  per new yellow — but only the *first* time you discover each one, so you can't
  farm time by re-typing the same letters.
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

```
app/components/WordleGame.vue   the game (state, board, keyboard, timer, UI)
shared/wordle.ts                pure rules: evaluate, validate, timer formula
shared/words/                   the official guess + answer word lists
shared/leaderboard.ts           leaderboard rules shared by client and server
server/api/leaderboard.get.ts   read the top 10
server/api/leaderboard.post.ts  save a score
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

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |

## Deployment

Deploys as a standard Nuxt app (e.g. Vercel). Set the two `NUXT_*` environment
variables in the host's dashboard — the local `.env` is not uploaded — and
redeploy so they take effect.

## Notes

- No accounts: the leaderboard keeps only the top 10 and trims the rest.
- The client-reported score is trusted (no anti-cheat), which is fine for a
  casual arcade game.

## License

[MIT](./LICENSE) © Crescenzo Sorrentino
