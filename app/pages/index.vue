<script setup lang="ts">
// Pagina iniziale: la testatina col titolo e il gioco. Resta volutamente
// minimale — tutta la logica sta in WordpaceGame, così questa pagina non
// cambia quasi mai.
</script>

<template>
  <main class="page">
    <header class="hero">
      <!--
        Sfondo della testatina: le celle del gioco stesso, sfumate.
        Non è un'illustrazione decorativa presa altrove — è il linguaggio
        visivo della griglia, così chi arriva capisce di che gioco si tratta
        prima ancora di leggere il sottotitolo.

        È disegnato qui dentro invece di essere un file .svg separato: nessuna
        richiesta di rete in più, i colori arrivano dalle stesse variabili del
        gioco, e resta nitido su qualsiasi schermo.

        aria-hidden perché è puramente decorativo: per un lettore di schermo
        annunciare venti rettangoli sarebbe solo rumore.
      -->
      <svg
        class="hero__pattern"
        viewBox="0 0 600 200"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <g class="hero__tiles">
          <!-- Riga alta -->
          <rect x="18" y="14" width="44" height="44" rx="3" />
          <rect x="70" y="14" width="44" height="44" rx="3" class="is-correct" />
          <rect x="122" y="14" width="44" height="44" rx="3" />
          <rect x="434" y="14" width="44" height="44" rx="3" />
          <rect x="486" y="14" width="44" height="44" rx="3" class="is-present" />
          <rect x="538" y="14" width="44" height="44" rx="3" />

          <!-- Riga centrale, arretrata per lasciare respiro al titolo -->
          <rect x="-8" y="66" width="44" height="44" rx="3" class="is-absent" />
          <rect x="44" y="66" width="44" height="44" rx="3" />
          <rect x="512" y="66" width="44" height="44" rx="3" />
          <rect x="564" y="66" width="44" height="44" rx="3" class="is-correct" />

          <!-- Riga bassa -->
          <rect x="18" y="118" width="44" height="44" rx="3" />
          <rect x="70" y="118" width="44" height="44" rx="3" />
          <rect x="122" y="118" width="44" height="44" rx="3" class="is-present" />
          <rect x="174" y="118" width="44" height="44" rx="3" />
          <rect x="382" y="118" width="44" height="44" rx="3" />
          <rect x="434" y="118" width="44" height="44" rx="3" class="is-correct" />
          <rect x="486" y="118" width="44" height="44" rx="3" />
          <rect x="538" y="118" width="44" height="44" rx="3" />
        </g>
      </svg>

      <div class="hero__content">
        <h1 class="hero__title">Wordpace</h1>
        <p class="hero__tagline">Keep the pace</p>
      </div>
    </header>

    <WordpaceGame />
  </main>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  min-height: 100vh;
  padding: 0 1rem 3rem;
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

/* === Testatina ===
   La fascia esce dai margini della pagina e tocca i bordi dello schermo.
   Lo fa con margini negativi pari al padding di .page, e NON con `100vw`:
   quella misura include anche la barra di scorrimento, quindi sui computer che
   la mostrano sempre la fascia risulterebbe più larga della finestra e
   comparirebbe una barra di scorrimento orizzontale. */
.hero {
  position: relative; /* riferimento per lo sfondo, che sta sotto in assoluto */
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(100% + 2rem);
  margin: 0 -1rem;
  padding: clamp(1.75rem, 7vw, 3rem) 1rem clamp(1.25rem, 4vw, 2rem);
  overflow: hidden; /* le celle che escono dai bordi vengono tagliate */
  border-bottom: 1px solid #d3d6da;
}

.hero__pattern {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* Sfuma verso il centro, così il titolo resta su fondo pulito e leggibile
     invece di sovrapporsi ai riquadri. Il prefisso -webkit- serve alle versioni
     di Safari precedenti alla 15.4. */
  -webkit-mask-image: radial-gradient(
    ellipse 55% 95% at center,
    transparent 32%,
    #000 78%
  );
  mask-image: radial-gradient(
    ellipse 55% 95% at center,
    transparent 32%,
    #000 78%
  );
}

/* I riquadri vuoti: solo il contorno, come le celle non ancora giocate. */
.hero__tiles rect {
  fill: none;
  stroke: #d3d6da;
  stroke-width: 2;
}

/* I tre colori del gioco, molto smorzati: devono suggerire, non gridare. */
.hero__tiles .is-correct {
  fill: #5f9e58;
  stroke: #5f9e58;
  opacity: 0.55;
}

.hero__tiles .is-present {
  fill: #ab8f3a;
  stroke: #ab8f3a;
  opacity: 0.5;
}

.hero__tiles .is-absent {
  fill: #787c7e;
  stroke: #787c7e;
  opacity: 0.3;
}

.hero__content {
  position: relative; /* sopra lo sfondo */
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  text-align: center;
}

.hero__title {
  margin: 0;
  /* Cresce con lo schermo ma si ferma: oltre una certa dimensione il titolo
     comincerebbe a competere con la griglia del gioco. */
  font-size: clamp(1.9rem, 8.5vw, 3.25rem);
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  line-height: 1;
  /* Con le lettere spaziate resta uno spazio anche dopo l'ultima: senza questo
     rientro la parola sembrerebbe spostata a sinistra. */
  text-indent: 0.16em;
}

.hero__tagline {
  margin: 0;
  font-size: clamp(0.62rem, 2.6vw, 0.78rem);
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  text-indent: 0.22em;
  color: #6e7275;
}

/* Sui telefoni le celle laterali sono più vicine al titolo: si attenuano
   ulteriormente perché non gli rubino leggibilità. */
@media (max-width: 560px) {
  .hero__pattern {
    opacity: 0.65;
  }
}

/* Chi ha chiesto al sistema di ridurre gli effetti visivi non ha bisogno di uno
   sfondo decorativo: glielo togliamo del tutto. */
@media (prefers-reduced-motion: reduce) {
  .hero__pattern {
    display: none;
  }
}
</style>
