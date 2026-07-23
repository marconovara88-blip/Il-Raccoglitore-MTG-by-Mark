// Service worker del Raccoglitore MTG.
// Mette in cache solo la "scocca" dell'app (HTML, manifest, icone) così si apre
// istantaneamente e resta utilizzabile offline. Le chiamate a Scryfall,
// Firebase/Firestore e Cardmarket passano sempre dritte in rete: i dati e i
// prezzi non vengono mai serviti da una cache vecchia.
const CACHE_NAME = 'raccoglitore-mtg-shell-v47';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const PASSTHROUGH_HOSTS = [
  'api.scryfall.com',
  'firestore.googleapis.com',
  'googleapis.com',
  'gstatic.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cardmarket.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Lascia passare direttamente alla rete tutte le chiamate verso servizi
  // esterni: dati carte, prezzi e sincronizzazione cloud devono essere
  // sempre aggiornati, mai serviti dalla cache dell'app.
  if (PASSTHROUGH_HOSTS.some((host) => url.includes(host))) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});

/* =========================================================================
   AGGIORNAMENTO PREZZI IN BACKGROUND (Background Sync API)
   -------------------------------------------------------------------------
   Quando la pagina registra il tag "sync-refresh-prices" (dopo un clic su
   "Aggiorna tutto"), il browser può eseguire questo codice anche se l'app
   è stata chiusa nel frattempo — è un vero meccanismo del browser pensato
   per questo, ma è "best effort": è il sistema operativo/browser a decidere
   quando eseguirlo (di norma in fretta se c'è connessione, ma senza garanzia
   di un tempo esatto). Funziona su Chrome/Android; browser che non
   supportano la Background Sync API (Safari/iOS, Firefox) continueranno
   comunque ad aggiornare regolarmente mentre l'app resta aperta, semplicemente
   senza questa rete di sicurezza in più.

   Per poter leggere e scrivere il documento anche da qui, senza includere
   l'intera libreria Firebase in background, questi valori duplicano quelli
   già presenti in FIREBASE_CONFIG dentro index.html (una API key web di
   Firebase non è un segreto: la protezione reale sta nelle regole di
   sicurezza di Firestore). */
const FIREBASE_PROJECT_ID = 'marco-f6bcb';
const FIREBASE_API_KEY = 'AIzaSyBDq_vqud0UFLseeseJy5HNt8ZR2sjeDUo';
const FIRESTORE_DOC_URL =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/mtg_raccoglitore/collezione?key=${FIREBASE_API_KEY}`;

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-refresh-prices') {
    event.waitUntil(refreshPricesInBackground());
  }
});

function detectTypeFromLineSW(typeLine) {
  if (!typeLine) return 'altro';
  const order = [
    ['Planeswalker', 'planeswalker'], ['Land', 'terra'], ['Creature', 'creatura'],
    ['Instant', 'istantaneo'], ['Sorcery', 'stregoneria'], ['Artifact', 'artefatto'],
    ['Enchantment', 'incantesimo']
  ];
  for (const [needle, key] of order) {
    if (typeLine.includes(needle)) return key;
  }
  return 'altro';
}

async function refreshPricesInBackground() {
  const getRes = await fetch(FIRESTORE_DOC_URL);
  if (!getRes.ok) return;
  const doc = await getRes.json();
  const raw = doc.fields && doc.fields.data && doc.fields.data.stringValue;
  if (!raw) return;

  const state = JSON.parse(raw);
  const cards = Array.isArray(state.cards) ? state.cards : [];

  for (const c of cards) {
    try {
      const url = c.scryfallId
        ? `https://api.scryfall.com/cards/${c.scryfallId}`
        : `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(c.name)}${c.setCode ? '&set=' + c.setCode.toLowerCase() : ''}`;
      const scRes = await fetch(url);
      if (!scRes.ok) continue;
      const sc = await scRes.json();

      const newEur = sc.prices && sc.prices.eur ? parseFloat(sc.prices.eur) : null;
      const newFoilEur = sc.prices && sc.prices.eur_foil ? parseFloat(sc.prices.eur_foil) : null;
      const oldRelevant = c.foil ? c.priceFoilEur : c.priceEur;
      const newRelevant = c.foil ? (newFoilEur ?? c.priceFoilEur) : (newEur ?? c.priceEur);
      if (typeof oldRelevant === 'number' && typeof newRelevant === 'number' && oldRelevant > 0) {
        const pct = ((newRelevant - oldRelevant) / oldRelevant) * 100;
        c.priceTrend = Math.abs(pct) >= 0.5 ? pct : 0;
      } else {
        c.priceTrend = null;
      }

      if (newEur != null) c.priceEur = newEur;
      if (newFoilEur != null) c.priceFoilEur = newFoilEur;
      c.priceUpdated = new Date().toISOString();
      if (!c.scryfallId) c.scryfallId = sc.id;
      if (!c.scryfallUri && sc.scryfall_uri) c.scryfallUri = sc.scryfall_uri;
      if (!c.imageUrl) {
        const img = (sc.image_uris && sc.image_uris.normal) ||
          (sc.card_faces && sc.card_faces[0] && sc.card_faces[0].image_uris && sc.card_faces[0].image_uris.normal) || '';
        if (img) c.imageUrl = img;
      }
      if (!c.type || c.type === 'altro') {
        const typeLine = sc.type_line || (sc.card_faces && sc.card_faces[0] && sc.card_faces[0].type_line) || '';
        const detected = detectTypeFromLineSW(typeLine);
        if (detected !== 'altro') c.type = detected;
      }
    } catch (e) {
      /* prova comunque a completare le altre carte */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  state.cards = cards;
  await fetch(FIRESTORE_DOC_URL, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        data: { stringValue: JSON.stringify(state) },
        updatedAt: { stringValue: new Date().toISOString() }
      }
    })
  });
}
