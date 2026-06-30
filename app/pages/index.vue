<script setup lang="ts">
// Home page: renders the game board. For now it is just the classic Wordle
// (step 1). Levels, timer and leaderboard will be layered on top in later
// steps without changing this page much.
</script>

<template>
  <main class="page">
    <h1 class="page__title">Wordle Arcade</h1>
    <WordleGame />
  </main>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  min-height: 100vh;
  padding: 1.5rem 1rem 3rem;
  box-sizing: border-box;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    sans-serif;
  background: #ffffff;
  color: #1a1a1a;
}

.page__title {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
