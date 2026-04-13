#!/usr/bin/env node
/**
 * 2-elabora-v2.js
 * FASE 2 — Nuova architettura v2
 *
 * Legge _draft-v2.json prodotto da 1-fetch-v2.js.
 * Gli articoli sono già completi (testo, commenti, relazioni aggiornate).
 * Questa fase si occupa di:
 * - Validare e normalizzare i dati
 * - Aggiungere auth_info.json e active_config_v2.json
 * - Produrre _articles-v2.json pronto per il deploy
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.join(__dirname, "..");
const DATA_DIR  = path.join(BASE_DIR, "public", "data");

const LOG_PATH          = path.join(DATA_DIR, "redazione-v2.log");
const DRAFT_PATH        = path.join(DATA_DIR, "_draft-v2.json");
const ARTICLES_PATH     = path.join(DATA_DIR, "_articles-v2.json");
const AUTH_PATH         = path.join(DATA_DIR, "auth_info.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config_v2.json");
const CONFIG_PATH       = path.join(DATA_DIR, "config_v2.json");

const adminPwd  = process.env.ADMIN_PASSWORD   || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto.";

// ---------------------------------------------------------------------------
// UTILITÀ
// ---------------------------------------------------------------------------

function scriviLog(msg) {
    const ts = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    const riga = `[${ts}] [2-elabora-v2] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
    scriviLog("⚙️ FASE 2-v2 — Avvio elaborazione...");

    if (!fs.existsSync(DRAFT_PATH)) {
        scriviLog(`ERRORE: ${DRAFT_PATH} non trovato. Eseguire prima 1-fetch-v2.js`);
        process.exit(1);
    }

    const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, "utf8"));
    const { oraAggiornamento, agenda, impostazioni, stili, sezioni } = draft;

    // --- Aggiorna active_config_v2.json ---
    if (fs.existsSync(CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        config.site_settings = {
            ...(config.site_settings || {}),
            last_update: oraAggiornamento,
            timbro: agenda?.timbro || "",
            banner: agenda?.banner || "",
            motto: impostazioni?.motto || "",
            header_img: impostazioni?.header_fisso || "",
            stato_sito: impostazioni?.stato_sito || "attivo",
            alert_api_rotto: impostazioni?.alert_api_rotto || "",
            ticker_news: impostazioni?.ticker_news || []
        };
        fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(config, null, 2));
        scriviLog("📄 active_config_v2.json aggiornato.");
    }

    // --- Aggiorna auth_info.json ---
    const hash = crypto.createHash("sha256").update(adminPwd).digest("hex");
    const encrypted = Buffer.from(secretData).toString("base64");
    fs.writeFileSync(AUTH_PATH, JSON.stringify({
        check: hash,
        data: encrypted,
        ts: oraAggiornamento
    }));
    scriviLog("🔐 auth_info.json aggiornato.");

    // --- Normalizza e valida articoli ---
    const scuseDelfino = [
        "Il Delfino è in sciopero per carenza di arrosticini.",
        "Lo stagista ha rovesciato la genziana sul server.",
        "Notizia troppo assurda perfino per noi.",
        "L'IA è andata a farsi il bagno a Pescara Vecchia."
    ];
    const scusa = () => scuseDelfino[Math.floor(Math.random() * scuseDelfino.length)];

    const articles = {
        oraAggiornamento,
        agenda,
        impostazioni,
        stili,
        sezioni: {}
    };

    for (const [sez, datiSez] of Object.entries(sezioni)) {
        const articoliNormalizzati = [];

        for (const art of (datiSez.articoli || [])) {
            // Valida campi obbligatori
            const titolo   = art.titolo?.trim()   || art.fallback?.titolo   || "Notizia senza titolo";
            const articolo = art.articolo?.trim()  || art.fallback?.articolo || scusa();

            // commento_firma
            const commentoFirma = art.commento_firma || { nome: "Redazione", avatar: "🐬", testo: scusa() };
            if (!commentoFirma.testo?.trim()) commentoFirma.testo = scusa();

            // commenti personaggi — filtra eventuali vuoti
            const commenti = (art.commenti || []).filter(c => c.nome && c.testo?.trim());

            articoliNormalizzati.push({
                tipo:           art.tipo || "rss",
                titolo,
                articolo,
                commento_firma: commentoFirma,
                commenti,
                categoria:      art.categoria || "Generale",
                colore_tipo:    art.colore_tipo || stili?.RSS || "#008cff",
                // immagine null = articolo personaggio (frame verde senza img)
                immagine:       art.immagine || "default_personaggio.webp"
            });
        }

        articles.sezioni[sez] = {
            color: datiSez.color || "#005f73",
            news: articoliNormalizzati
        };

        scriviLog(`✅ Sezione ${sez}: ${articoliNormalizzati.length} articoli normalizzati.`);
    }

    fs.writeFileSync(ARTICLES_PATH, JSON.stringify(articles, null, 2));
    scriviLog(`✅ FASE 2-v2 completata. Articles → ${ARTICLES_PATH}`);
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
