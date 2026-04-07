#!/usr/bin/env node
/**
 * 3-deploy.js
 * FASE 3: Legge _articles.json prodotto dalla fase 2.
 * Scrive i file JSON finali in public/data/ (letti dall'index.html)
 * e fa git add + commit + push per aggiornare GitHub Pages.
 *
 * Attivato da commit con [run-3] nel messaggio,
 * oppure chiamato direttamente da 4-auto.js.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const ARTICLES_PATH = path.join(DATA_DIR, "_articles.json");

// ---------------------------------------------------------------------------
// UTILITÀ
// ---------------------------------------------------------------------------

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const riga = `[${ts}] [3-deploy] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

function eseguiGit(cmd) {
    try {
        const output = execSync(cmd, { cwd: BASE_DIR, encoding: "utf8" });
        if (output.trim()) scriviLog(`[git] ${output.trim()}`);
    } catch (e) {
        // Se non ci sono modifiche da committare, git esce con codice 1: non è un errore bloccante
        const msg = e.stderr?.trim() || e.stdout?.trim() || e.message;
        if (msg.includes("nothing to commit") || msg.includes("nothing added")) {
            scriviLog(`[git] Nessuna modifica da committare.`);
        } else {
            scriviLog(`[ERRORE git] ${msg}`);
            throw e;
        }
    }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
    scriviLog("🚀 FASE 3 — Avvio deploy...");

    if (!fs.existsSync(ARTICLES_PATH)) {
        scriviLog(`ERRORE: ${ARTICLES_PATH} non trovato. Eseguire prima le fasi 1 e 2.`);
        process.exit(1);
    }

    const articles = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf8'));
    const { oraAggiornamento, sezioni } = articles;

    // Calcola orario prossimo aggiornamento solo se siamo in modalità automatica
    const isAutomatico = process.env.WORKFLOW_AUTOMATICO === 'true';
    const prossimoAggiornamento = isAutomatico
        ? new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleString('it-IT', {
            timeZone: 'Europe/Rome',
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit'
        })
        : 'Aggiornamenti sospesi';

    // Scrivi un file JSON per sezione (es. public/data/news-mondo.json)
    for (const [sez, datiSez] of Object.entries(sezioni)) {
        const outPath = path.join(DATA_DIR, `news-${sez}.json`);
        const payload = { color: datiSez.color, news: datiSez.news };
        payload.prossimo_aggiornamento = prossimoAggiornamento;
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
        scriviLog(`📄 Scritto: news-${sez}.json (${datiSez.news.length} articoli)`);
    }

    scriviLog(`🕐 Ora aggiornamento: ${oraAggiornamento}`);

    // Configura git (necessario in ambiente CI/GitHub Actions)
    eseguiGit(`git config user.name "La Voce del Delfino Bot"`);
    eseguiGit(`git config user.email "bot@lavocedeldelfino.it"`);

    // Aggiungi tutti i file modificati in public/data/
    eseguiGit(`git add public/data/`);

    // Commit con timestamp
    eseguiGit(`git commit -m "🤖 Aggiornamento redazione ${oraAggiornamento} [skip ci]"`);

    // Push sul branch corrente
    eseguiGit(`git push`);

    scriviLog(`✅ FASE 3 completata. Dati pubblicati su GitHub Pages.`);
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
