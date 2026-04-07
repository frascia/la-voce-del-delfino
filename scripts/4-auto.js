#!/usr/bin/env node
/**
 * 4-auto.js
 * ORCHESTRATORE — Chiamato esclusivamente dal workflow automatico (cron).
 * Esegue sempre la sequenza completa: FASE 1 → FASE 2 → FASE 3.
 *
 * I file 1-fetch.js, 2-elabora.js, 3-deploy.js possono anche essere
 * attivati manualmente tramite commit con tag [run-N] nel messaggio
 * (gestito dal workflow manuale, non da questo file).
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(BASE_DIR, "public", "data");
const LOG_PATH = path.join(DATA_DIR, "redazione.log");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const riga = `[${ts}] [4-auto] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

function eseguiFase(script) {
    const scriptPath = path.join(__dirname, script);
    scriviLog(`▶️  Avvio ${script}...`);
    try {
        execSync(`node ${scriptPath}`, {
            stdio: "inherit",   // stampa stdout/stderr del child in tempo reale
            cwd: __dirname
        });
        scriviLog(`✅ ${script} completato.`);
    } catch (e) {
        scriviLog(`❌ ${script} ha fallito con codice ${e.status}.`);
        throw e;
    }
}

async function main() {
    scriviLog("═══════════════════════════════════════");
    scriviLog("🐬 La Voce del Delfino — Ciclo Automatico");
    scriviLog("═══════════════════════════════════════");

    eseguiFase("1-fetch.js");
    eseguiFase("2-elabora.js");
    eseguiFase("3-deploy.js");

    scriviLog("🏁 Ciclo completo terminato con successo.");
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO nel ciclo automatico: ${err.message}`);
    process.exit(1);
});
