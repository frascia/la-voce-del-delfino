#!/usr/bin/env node
/**
 * 2-elabora.js
 * FASE 2: Legge _draft.json prodotto dalla fase 1.
 * Fa il parsing dei JSON grezzi di Gemini, applica i fallback,
 * aggiunge i commenti del Delfino e salva _articles.json per la fase 3.
 *
 * Attivato da commit con [run-2] o [run-3] nel messaggio,
 * oppure chiamato direttamente da 4-auto.js.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const DRAFT_PATH = path.join(DATA_DIR, "_draft.json");
const ARTICLES_PATH = path.join(DATA_DIR, "_articles.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto impostato.";

// ---------------------------------------------------------------------------
// UTILITÀ
// ---------------------------------------------------------------------------

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const riga = `[${ts}] [2-elabora] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

/**
 * Pulisce e parsa il JSON grezzo restituito da Gemini
 */
function parseJSON(raw) {
    try {
        if (!raw) return null;
        const inizioArray = raw.indexOf('[');
        const fineArray = raw.lastIndexOf(']');
        const inizioOggetto = raw.indexOf('{');
        const fineOggetto = raw.lastIndexOf('}');

        if (inizioArray !== -1 && fineArray !== -1 && (inizioOggetto === -1 || inizioArray < inizioOggetto)) {
            const jsonString = raw.substring(inizioArray, fineArray + 1);
            const parsedArray = JSON.parse(jsonString);
            return Array.isArray(parsedArray) && parsedArray.length > 0 ? parsedArray[0] : null;
        }

        if (inizioOggetto !== -1 && fineOggetto !== -1 && fineOggetto >= inizioOggetto) {
            const jsonString = raw.substring(inizioOggetto, fineOggetto + 1);
            return JSON.parse(jsonString);
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
    scriviLog("⚙️ FASE 2 — Avvio elaborazione draft...");

    if (!fs.existsSync(DRAFT_PATH)) {
        scriviLog(`ERRORE: ${DRAFT_PATH} non trovato. Eseguire prima la fase 1.`);
        process.exit(1);
    }

    const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
    const { oraAggiornamento, configUsata } = draft;

    // Aggiorna active_config con timestamp corrente
    if (fs.existsSync(configUsata)) {
        const CONFIG = JSON.parse(fs.readFileSync(configUsata, 'utf8'));
        CONFIG.site_settings.last_update = oraAggiornamento;
        fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    }

    // Scrive auth_info.json (hash password + segreto cifrato)
    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = Buffer.from(secretData).toString('base64');
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: encrypted, ts: oraAggiornamento }));

    const scuseDelfino = [
        "Il Delfino è in sciopero per carenza di arrosticini.",
        "Lo stagista ha rovesciato la genziana sul server del sito.",
        "Notizia troppo assurda perfino per noi, ci asteniamo.",
        "La nostra Intelligenza Artificiale è andata a farsi il bagno a Pescara Vecchia."
    ];

    const scusa = () => scuseDelfino[Math.floor(Math.random() * scuseDelfino.length)];

    // Struttura output: { sezioni: { [sez]: { color, news: [...] } } }
    const articles = { oraAggiornamento, sezioni: {} };

    for (const [sez, datiSez] of Object.entries(draft.sezioni)) {
        const newsSezione = [];

        for (const item of datiSez.articoli) {
            const parsed = parseJSON(item.raw);

            if (parsed) {
                // Gemini ha risposto correttamente
                const commento = parsed.commento || scusa();
                if (item.tipo === "satira") {
                    newsSezione.push({
                        titolo: parsed.titolo,
                        articolo: parsed.articolo,
                        commento,
                        categoria: item.categoria,
                        immagine: item.immagine,
                        is_satira: true
                    });
                } else {
                    newsSezione.push({
                        titolo: parsed.titolo,
                        articolo: parsed.articolo,
                        commento,
                        categoria: item.categoria,
                        immagine: item.immagine
                    });
                }
            } else {
                // Fallback: Gemini non ha risposto o ha restituito JSON invalido
                if (item.tipo === "satira") {
                    newsSezione.push({
                        titolo: item.fallback.titolo,
                        articolo: item.fallback.articolo,
                        commento: scusa(),
                        categoria: item.categoria,
                        immagine: item.immagine,
                        is_satira: true
                    });
                } else {
                    newsSezione.push({
                        titolo: item.fallback.titolo,
                        articolo: item.fallback.articolo,
                        commento: scusa(),
                        categoria: item.categoria,
                        immagine: item.immagine
                    });
                }
            }
        }

        articles.sezioni[sez] = {
            color: datiSez.color,
            news: newsSezione
        };

        scriviLog(`Sezione ${sez}: ${newsSezione.length} articoli elaborati.`);
    }

    fs.writeFileSync(ARTICLES_PATH, JSON.stringify(articles, null, 2));
    scriviLog(`✅ FASE 2 completata. Articoli salvati in ${ARTICLES_PATH}`);
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
