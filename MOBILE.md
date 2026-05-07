# Mobile (Android/iOS) con Capacitor

Questa repo include una web app in `web/` che può essere impacchettata come app **Android** e **iOS** usando **Capacitor**.

## Nota importante (toolchain)

Su questa macchina al momento **manca `npm`**, quindi i comandi `npx cap ...` non possono essere eseguiti direttamente.
Per questo motivo trovi due strade:

1) Eseguire i comandi Capacitor su una macchina con `npm` (consigliato)\n
2) Eseguire i comandi Capacitor **in Docker** usando `mobile.Dockerfile` (se hai Docker Desktop)

## Configurazione API (obbligatoria in app)

In app mobile non puoi usare `localhost` del PC. Devi puntare a un backend pubblico.

- Modifica `web/config.js` e imposta:\n
  - `window.__API_BASE_URL__ = "https://<tuo-dominio>";`

## Generazione progetti Android/iOS

### Opzione A: con npm (macchina dev)

```bash
npm install
npx cap add android
npx cap add ios
npx cap sync
```

### Opzione B: con Docker (se disponibile)

Build immagine tool:

```bash
docker build -f mobile.Dockerfile -t parking-finder-mobile .
```

Genera Android:

```bash
docker run --rm -v "%cd%:/app" -w /app parking-finder-mobile npx cap add android
docker run --rm -v "%cd%:/app" -w /app parking-finder-mobile npx cap sync android
```

Genera iOS (serve comunque macOS per build/sign):\n

```bash
docker run --rm -v "%cd%:/app" -w /app parking-finder-mobile npx cap add ios
docker run --rm -v "%cd%:/app" -w /app parking-finder-mobile npx cap sync ios
```

## Run

### Android (Windows)

- Apri `android/` con Android Studio e premi Run.

### iOS

- Richiede macOS + Xcode.\n
- Apri `ios/` con Xcode e premi Run.

