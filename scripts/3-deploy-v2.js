#!/usr/bin/env node
/**
 * 3-deploy-v2.js
 * FASE 3 — Nuova architettura v2
 *
 * Legge _articles-v2.json e scrive i file JSON finali in public/data/.
 * Aggiunge prossimo_aggiornamento se il run è automatico.
 * Fa git add + commit + push.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.join(__dirname, "..");
const DATA_DIR  = path.join(BASE_DIR, "public", "data");

const LOG_PATH      = path.join(DATA_DIR, "redazione-v2.log");
const ARTICLES_PATH = path.join(DATA_DIR, "_articles-v2.json");

// ---------------------------------------------------------------------------
// UTILITÀ
// ---------------------------------------------------------------------------

function scriviLog(msg) {
    const ts = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    const riga = `[${ts}] [3-deploy-v2] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

function eseguiGit(cmd) {
    try {
        const out = execSync(cmd, { cwd: BASE_DIR, encoding: "utf8" });
        if (out.trim()) scriviLog(`[git] ${out.trim()}`);
    } catch (e) {
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
    scriviLog("🚀 FASE 3-v2 — Avvio deploy...");

    if (!fs.existsSync(ARTICLES_PATH)) {
        scriviLog(`ERRORE: ${ARTICLES_PATH} non trovato. Eseguire prima le fasi 1 e 2.`);
        process.exit(1);
    }

    const articles = JSON.parse(fs.readFileSync(ARTICLES_PATH, "utf8"));
    const { oraAggiornamento, sezioni, agenda, impostazioni, stili } = articles;

    // Prossimo aggiornamento — solo se workflow automatico (cron)
    const isAutomatico = process.env.WORKFLOW_AUTOMATICO === "true";
    const prossimoAggiornamento = isAutomatico
        ? new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleString("it-IT", {
            timeZone: "Europe/Rome",
            hour: "2-digit", minute: "2-digit",
            day: "2-digit", month: "2-digit"
        })
        : "Aggiornamenti sospesi";

    // --- Scrivi news-v2-{sez}.json per ogni sezione ---
    for (const [sez, datiSez] of Object.entries(sezioni)) {
        const outPath = path.join(DATA_DIR, `news-v2-${sez}.json`);
        fs.writeFileSync(outPath, JSON.stringify({
            color: datiSez.color,
            prossimo_aggiornamento: prossimoAggiornamento,
            news: datiSez.news
        }, null, 2));
        scriviLog(`📄 Scritto: news-v2-${sez}.json (${datiSez.news.length} articoli)`);
    }

    scriviLog(`🕐 Ora: ${oraAggiornamento} | Prossimo: ${prossimoAggiornamento}`);

    // --- Git ---
    eseguiGit(`git config user.name "DelfinoBot"`);
    eseguiGit(`git config user.email "bot@lavocedeldelfino.it"`);
    // Prima allinea, poi scrivi i file, poi committa
    eseguiGit(`git fetch origin main`);
    eseguiGit(`git reset --hard origin/main`);
    eseguiGit(`git add public/data/`);
    eseguiGit(`git commit -m "🤖 Redazione v2 ${oraAggiornamento} [skip ci]"`);
    eseguiGit(`git push`);

    scriviLog(`✅ FASE 3-v2 completata. Dati pubblicati.`);
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
