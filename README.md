# 🐬 La Voce del Delfino 2 

Giornale automatico illustrato in stile Ghibli. Si aggiorna ogni ora via GitHub Actions usando **Google Gemini AI** (tier gratuito disponibile).

## Setup in 5 minuti

### 1. Crea il repo su GitHub e carica questi file (mantieni la struttura delle cartelle)

### 2. Ottieni la GEMINI_API_KEY gratuita
- Vai su [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Clicca **"Create API Key"**
- Copia la chiave (es. `AIzaSy...`)

### 3. Aggiungi il secret nel repo GitHub
- **Settings → Secrets and variables → Actions → New repository secret**
- Nome: `GEMINI_API_KEY`
- Valore: la chiave copiata da AI Studio

### 4. Abilita GitHub Pages
- **Settings → Pages → Source: GitHub Actions** → Salva

### 5. Abilita i workflow
- **Actions → "I understand my workflows, enable them"**

### 6. Primo avvio manuale
- **Actions → 🐬 Aggiorna Notizie → Run workflow**
- Aspetta ~20 minuti (20 notizie + 21 illustrazioni SVG × 2 sezioni, con pause per il rate limit)

Il sito sarà su `https://TUO_USERNAME.github.io/voce-del-delfino`

---

## Architettura

```
Ogni ora (cron GitHub Actions):
  scripts/fetch-news.js
    ├── Gemini + Google Search → 20 notizie reali cercate sul web
    ├── Gemini → 1 notizia satirica inventata
    ├── Gemini × 21 → SVG acquerello Ghibli per ogni notizia
    ├── Salva → public/data/news-mondo.json
    └── Salva → public/data/news-pescara.json
    → git commit & push → trigger deploy

  .github/workflows/deploy.yml
    → npm run build (React)
    → Deploy su GitHub Pages
```

## Modelli Gemini usati

| Uso | Modello | Costo |
|-----|---------|-------|
| Ricerca notizie (Google Search) | `gemini-2.0-flash` | Gratuito (1500 req/giorno) |
| Formattazione JSON sarcastico | `gemini-2.0-flash` | Gratuito |
| Notizia satirica | `gemini-2.0-flash` | Gratuito |
| Illustrazioni SVG Ghibli | `gemini-2.0-flash` | Gratuito |

Il **tier gratuito di Gemini** permette 1500 richieste/giorno e 15 req/minuto.
Ogni aggiornamento usa ~50 chiamate (2 sezioni × 25 call circa) → ampiamente nei limiti.

## Modifica frequenza aggiornamento

Cambia il cron in `.github/workflows/update-news.yml`:
```yaml
# Ogni ora (default)
- cron: '0 * * * *'

# Ogni 6 ore (più rilassato)
- cron: '0 */6 * * *'

# Una volta al giorno alle 8:00 UTC
- cron: '0 8 * * *'
```
