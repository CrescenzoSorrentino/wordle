<script setup lang="ts">
// Pagina iniziale: disegna il titolo e il gioco. Resta volutamente minimale —
// tutta la logica sta in WordleGame, così questa pagina non cambia quasi mai.
</script>

<template>
  <main class="page">
    <header class="page__head">
      <h1 class="page__title">Wordle Arcade</h1>
      <p class="page__subtitle">Endless levels · Beat the clock · Learn words</p>
    </header>
    <WordleGame />
  </main>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  min-height: 100vh;
  padding: 1.25rem 1rem 3rem;
  box-sizing: border-box;
  font-family:
    "Helvetica Neue",
    -apple-system,
    Helvetica,
    Arial,
    sans-serif;
  background: #ffffff;
  color: #1a1a1a;
}

/* Testatina separata dal gioco da un filetto, come nel Wordle originale. */
.page__head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  width: 100%;
  max-width: 30rem;
  padding-bottom: 0.9rem;
  border-bottom: 1px solid #d3d6da;
  text-align: center;
}

.page__title {
  margin: 0;
  font-size: clamp(1.6rem, 6.5vw, 2rem);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  line-height: 1.1;
}

.page__subtitle {
  margin: 0;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #6e7275;
}
</style>
