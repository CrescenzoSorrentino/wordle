// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // Titolo, descrizione e lingua della pagina: servono alla scheda del browser
  // e alle anteprime quando il link viene condiviso.
  app: {
    head: {
      title: 'Wordpace',
      htmlAttrs: { lang: 'en' },
      meta: [
        {
          name: 'description',
          content:
            'An endless, time-pressured five-letter word game: beat the clock, climb the leaderboard, learn a word every level.',
        },
      ],
    },
  },

  // Configurazione della classifica, visibile solo al server. Le stringhe vuote
  // sono segnaposto: Nuxt sostituisce ogni chiave con la variabile d'ambiente
  // NUXT_<CHIAVE> corrispondente (vedi .env.example). Non stando sotto
  // "public", non finiscono mai nel browser: le credenziali restano segrete.
  runtimeConfig: {
    upstashRedisRestUrl: '',
    upstashRedisRestToken: '',
  },
})
