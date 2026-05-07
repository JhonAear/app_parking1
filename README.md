## Parking Finder (MVP)

Prototipo web “zero build” (file statici + server Node) per:

- **mappa** (MapLibre via CDN, tile OpenStreetMap)
- **parcheggi OSM** (Overpass via proxy backend + cache)
- **community** (segnalazioni utenti + like + commenti)
- **affidabilità** (voti “Confermo / Non confermo”)
- **login/registrazione** (username/password, session token)

### Avvio (locale)

1. Avvia il server:

```bash
node server.mjs
```

2. Apri nel browser:
   - `http://localhost:8787`

> Nota: aprire i file con `file://` può dare problemi (CORS/fetch). Usare sempre il server.

### Persistenza dati

- `data/users.json`: utenti (password hash `scrypt` + salt)
- `data/community-posts.json`: post community (likes, comments, votes)

### Deploy (URL pubblico)

Il server ascolta sulla porta `process.env.PORT` (default `8787`), quindi è deployabile su hosting che forniscono una porta.

#### Deploy con Docker (consigliato)

Build:

```bash
docker build -t parking-finder .
```

Run:

```bash
docker run --rm -p 8787:8787 -e PORT=8787 parking-finder
```

Apri: `http://localhost:8787`

#### Dev con Postgres (consigliato per “production-like”)

Usa `docker-compose.yml` (app + postgres):

```bash
docker compose up --build
```

Apri: `http://localhost:8787`

Opzioni rapide:

- **VPS**:
  - installa Node.js
  - copia il progetto
  - avvia con `PORT=80 node server.mjs` (o reverse proxy con Nginx)
- **Render / Fly.io / Railway**:
  - setta variabile `PORT` (se richiesto dalla piattaforma)
  - comando start: `node server.mjs`

Consiglio: per dettagli architetturali e API vedi `ARCHITETTURA.md`.

## Mobile (Android/iOS)

Questa app è pensata per funzionare principalmente da **smartphone**. La versione mobile consigliata è **Capacitor** (wrapper nativo) che riusa `web/`.

- Guida completa: `MOBILE.md`
- Punto chiave: in app devi configurare `web/config.js` con un **backend pubblico** (non `localhost`).

