# Architettura Parking Finder (MVP)

Questo documento spiega **tecnologie**, **architettura**, **struttura del progetto** e **flussi principali** (mappa, community, login) per permettere a un altro sviluppatore di continuare il lavoro.

## Tecnologie e sistemi usati

- **Frontend**: HTML/CSS/JavaScript “vanilla” (senza build, senza bundler).
- **Mappa**: **MapLibre GL JS** (CDN) con **tile raster OpenStreetMap**.
- **Backend**: **Node.js** (ESM) con `http` nativo (no Express), server statico + API.
- **Mobile app**: **Capacitor** (Android/iOS) che impacchetta `web/` come WebView nativa.
- **Dati esterni**:
  - **OpenStreetMap / Overpass API** per i parcheggi `amenity=parking` (proxy dal backend con fallback e cache).
  - **Nominatim** per geocoding (proxy dal backend).
- **Persistenza**:
  - `data/users.json`: utenti registrati (password hash con `scrypt`, salt per utente) + campi profilo (`displayName`, `bio`).
- `data/users.json`: include anche `reputationScore` (best-effort) quando si usano i file JSON.
  - `data/community-posts.json`: post community (segnalazioni) con like, commenti, voti affidabilità.
- `data/reports.json`: segnalazioni moderazione (report utenti) per i post community.
- **DB (consigliato)**: Postgres tramite `DATABASE_URL` (abilita persistenza robusta e sessioni persistenti).
- **Auth**:
  - Registrazione e login con username/password.
  - Sessioni in-memory: mappa `SESSIONS` (token -> user). Prototipo (non persistente tra riavvii).

## Struttura cartelle

```
parking-app/
  server.mjs              # Server Node: static + API + proxy OSM/Nominatim
  web/
    index.html            # UI principale + modali
    style.css             # Tema + layout desktop + layout mobile
    app.js                # Logica client: mappa, fetch, auth, feed, post, like/comment/vote
    config.js             # Config runtime (API_BASE_URL per app mobile)
  db/                     # Schema/migrazioni (Postgres, opzionale)
  MOBILE.md               # Istruzioni build Android/iOS (Capacitor)
  capacitor.config.ts     # Config Capacitor
  android/                # Generato da Capacitor (placeholder se non generato)
  ios/                    # Generato da Capacitor (placeholder se non generato)
  data/
    users.json            # Persistenza utenti (hash + salt)
    community-posts.json  # Persistenza post community (like/comment/votes)
  README.md               # Istruzioni base MVP
  ARCHITETTURA.md         # (questo file)
```

## Come avviare in locale

1. Avvio server:
   - `node server.mjs`
2. Apri nel browser:
   - `http://localhost:8787`

Note:
- Aprire i file con `file://` può causare problemi (CORS, fetch, style). Usare sempre il server.
- La porta è configurabile via `process.env.PORT` (default `8787`).

## Deploy (URL pubblico)

Il backend è un singolo processo Node e può essere deployato su:

- **VPS** (consigliato per controllo totale)
  - Node.js installato
  - opzionale: reverse proxy (Nginx) + HTTPS
  - avvio: `PORT=8787 node server.mjs` oppure gestore processi (PM2/systemd)
- **PaaS** (Render/Fly.io/Railway)
  - start: `node server.mjs`
  - impostare `PORT` se la piattaforma lo richiede

Requisiti:
- accesso in uscita verso Overpass e Nominatim (HTTPS)
- persistenza della cartella `data/` (volume) se vuoi mantenere utenti/post tra deploy

### Docker

File inclusi:
- `Dockerfile`
- `.dockerignore`

Esecuzione tipica:
- build: `docker build -t parking-finder .`
- run: `docker run --rm -p 8787:8787 -e PORT=8787 parking-finder`

### Docker Compose (dev con Postgres)

- `docker compose up --build`
- `DATABASE_URL` viene impostata a `postgres://parking:parking@db:5432/parking`

## Backend (`server.mjs`)

### Responsabilità

- **Static server**: serve file da `web/` (HTML/CSS/JS).
- **API auth**: register/login/me.
- **API community**: posts, like, comment, vote (affidabilità).
- **Anti-abuso**: rate limit in-memory su login, pubblicazione post, commenti, voti, report, live update.
- **Proxy OSM**: endpoint `/api/osm` verso Overpass con:
  - fallback tra più URL Overpass
  - timeout
  - cache in-memory per bbox (riduce errori 502 e migliora UX)
  - guardrail su bbox troppo grandi (richiede zoom maggiore)
- **Proxy geocode**: endpoint `/api/geocode` verso Nominatim.

### Endpoint API

#### Auth

- `POST /api/auth/register`
  - Body: `{ username, password }`
  - Risposta: `{ ok, token, user }`

- `POST /api/auth/login`
  - Body: `{ username, password }`
  - Risposta: `{ ok, token, user }`

- `GET /api/auth/me`
  - Header: `Authorization: Bearer <token>`
  - Risposta: `{ ok, user }`

#### Profilo utente

- `GET /api/profile`
  - Header: `Authorization: Bearer <token>`
  - Risposta: `{ ok, profile }`

- `POST /api/profile`
  - Header: `Authorization: Bearer <token>`
  - Body: `{ displayName, bio }`
  - Risposta: `{ ok, profile }`

#### Community

- `GET /api/community/posts`
  - Risposta: `{ ok, posts }`

- `POST /api/community/posts`
  - Header auth required
  - Body: `{ title, note, fee, lat, lon, kind, durationMin }`
  - Risposta: `{ ok, post }`

- `POST /api/community/posts/:id/like`
  - Header auth required
  - Toggle like dell’utente sul post
  - Risposta: `{ ok, likesCount, liked }`

- `POST /api/community/posts/:id/comments`
  - Header auth required
  - Body: `{ text }`
  - Risposta: `{ ok, comment, commentsCount }`

- `POST /api/community/posts/:id/vote`
  - Header auth required
  - Body: `{ value }` dove:
    - `1` = **Confermo**
    - `-1` = **Non confermo**
    - `0` = cancella il voto
  - Persistenza su `post.votes` come mappa `{ [userId]: 1|-1 }`

- `POST /api/community/posts/:id/report`
  - Header auth required
  - Body: `{ reason }` (opzionale)
  - Salva una segnalazione moderazione in `data/reports.json`

- `POST /api/community/posts/:id/availability`
  - Header auth required
  - Solo autore (MVP)
  - Body:
    - `{ action: "extend", durationMin: 15 }` per estendere la segnalazione live
    - `{ action: "occupied" }` per chiuderla

- `GET /api/community/reports` (admin)
  - Header auth required
  - Restituisce segnalazioni in `data/reports.json`

- `DELETE /api/community/posts/:id` (admin)
  - Header auth required
  - Cancella un post

#### Rate limiting (prototipo)

Implementato lato server in memoria (per IP/route). Limiti principali:
- login: 12/min
- register: 6/min
- create post: 20/min per utente
- commenti: 40/min per utente
- voti: 120/min per utente
- report: 10/min per utente
- live update: 30/min per utente

#### OSM + Geocode

- `GET /api/osm?s=<south>&w=<west>&n=<north>&e=<east>`
  - proxy Overpass per bbox attuale della mappa
  - Risposta: `{ ok, json, cached?, warning? }`

- `GET /api/geocode?q=<query>`
  - proxy Nominatim (limitato, Italia)
  - Risposta: `{ ok, results }`

## Frontend

### File

- `web/index.html`
  - Layout “social” a 3 colonne su desktop:
    - sinistra: menu
    - centro: mappa
    - destra: pannelli (cerca, segnala, feed, risultati)
  - Filtri mappa (toggle OSM/community + filtro costo OSM) dentro “Cerca zona”
  - Toggle “Solo LIVE (libero ora)” per mostrare solo segnalazioni live della community
  - Modali:
    - `postModal` (nuova segnalazione)
    - `postDetailModal` (dettaglio post: like, commenti, voti affidabilità, centra mappa)
    - `loginScreen` (login/registrazione obbligatoria)
    - `profileModal` (modifica profilo: display name + bio)

- `web/style.css`
  - Tema scuro, card UI.
  - **Desktop**: layout 3 colonne.
  - **Mobile** (`max-width: 640px`): UI “app-like”
    - mappa grande
    - bottom navigation (`.mobileNav`)
    - bottom sheet (`.mobileSheet`) per Cerca/Feed/Risultati/Segnala
    - sheet trascinabile (snap su 3 altezze)
  - Menu sinistro su desktop: comportamento a tab tramite `body[data-desktop-tab="..."]`.

- `web/app.js`
  - Inizializza MapLibre:
    - style raster OSM tile
    - marker “selected”
    - source GeoJSON con clustering
  - Dati mappa:
    - `parkings` = parcheggi OSM in vista
    - `communityPosts` = post community
    - `combinedForMap()` = unione dei due dataset per la mappa
  - Auth client:
    - token in `localStorage` (`SESSION_KEY`)
    - `apiFetch()` aggiunge Bearer token
    - `refreshMe()` gestisce gating UI (login obbligatorio)
  - Networking:
    - `API_BASE_URL` letto da `window.__API_BASE_URL__` (definito in `web/config.js`) per puntare a un backend pubblico in app mobile
  - Geolocalizzazione:
    - preferisce `window.Capacitor.Plugins.Geolocation` se disponibile, altrimenti `navigator.geolocation`
  - Community:
    - feed con like/commenta + voti “Confermo/Non confermo”
    - modale dettaglio con like/commenti/voti + “Centra”
    - pulsante “Apri su Maps” per aprire la coordinata su Google Maps
  - Admin (MVP):
    - modale `adminModal` che legge `/api/community/reports` e consente `DELETE /api/community/posts/:id` (se autorizzato dal server con `ADMIN_USERS`)
  - Responsive UI:
    - mobile: `setMobileTab(tab)` apre bottom sheet
    - desktop: `setDesktopTab(tab)` filtra i pannelli a destra e evidenzia menu sinistro
  - Robustezza mappa:
    - `safeResizeMap()` su resize/visibility + dopo toggle UI (per evitare mappa “nera”/0-size)
  - Auto-caricamento:
    - dopo login tenta geolocalizzazione e carica automaticamente i parcheggi OSM nella vista corrente
    - dopo selezione suggerimento geocoding carica automaticamente

## Modello dati (community post)

Oggetto post (in `data/community-posts.json`):

```json
{
  "id": "uuid",
  "title": "string",
  "note": "string",
  "fee": "unknown|free|paid|variable",
  "lat": 41.9,
  "lon": 12.5,
  "createdAtMs": 1710000000000,
  "author": { "userId": "uuid", "username": "mario_rossi" },
  "likes": ["userId1", "userId2"],
  "votes": { "userId1": 1, "userId3": -1 },
  "kind": "missing_report|availability",
  "expiresAtMs": 1710000000000,
  "availability": "free|occupied",
  "comments": [
    { "id": "uuid", "text": "string", "createdAtMs": 1710000000000, "author": { "userId": "uuid", "username": "..." } }
  ]
}
```

## Limiti noti (prototipo)

- **Sessioni in-memory**: al riavvio del server le sessioni si perdono (gli utenti restano su file).
- **Nessuna moderazione** (per ora).
- **OSM/Overpass**: dipende da servizi esterni; mitigato da fallback/cache/guardrail.
- **Non calcoliamo “posti liberi” real-time**: l’app mostra parcheggi noti + segnalazioni community.
- **Affidabilità (score)**: il punteggio mostrato è derivato dai voti ✅/❌ con un **decadimento nel tempo** basato sull’età del post (prototipo lato client).
- **Reputazione (server)**: quando un post riceve voti ✅/❌, la reputazione dell’autore viene incrementata/decrementata (Postgres: `users.reputation_score`; JSON: `reputationScore`).

## Prossimi step consigliati

- Deploy su hosting (Render/Fly.io/VPS) per URL pubblico.
- Migliorare reputazione/affidabilità:
  - pesare i voti per “reputazione”
  - decadimento temporale (voti vecchi contano meno)
- Persistenza sessioni (Redis o file DB).
- Profili utente (avatar, storico segnalazioni).

