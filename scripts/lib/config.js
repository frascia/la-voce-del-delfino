/**
 * FILE: lib/config.js
 * DATA: 2025-04-15
 * VERSIONE: 2.1
 * DESCRIZIONE: Caricamento e gestione della configurazione.
 *              Log dettagliato delle impostazioni all'avvio.
 */

import { caricaJSON } from "./utils.js";

let CONFIG = null;
let CONFIG_PATH = null;
let logFn = null;
const log = (msg) => logFn("[config] " + msg);

export function initConfig(path, logFunction) {
    CONFIG_PATH = path;
    logFn = logFunction;
}

export function loadConfig() {
    if (!CONFIG && CONFIG_PATH) {
        CONFIG = caricaJSON(CONFIG_PATH, {});
        if (CONFIG && Object.keys(CONFIG).length > 0) {
            log(`📁 Config caricata: ${CONFIG_PATH}`);
            
            // Log delle informazioni principali
            const impostazioni = CONFIG.IMPOSTAZIONI || {};
            const limiti = CONFIG.LIMITI || {};
            const numPersonaggi = Object.keys(CONFIG.CHI || {}).filter(k => k !== "default").length;
            const numVoci = (CONFIG.REDAZIONE || []).length;
            const fasceOrarie = limiti.fasce_articoli || [];
            
            // Conta i tipi di voce nella redazione
            const vociRSS = (CONFIG.REDAZIONE || []).filter(v => v.tipo === "RSS").length;
            const vociGEN = (CONFIG.REDAZIONE || []).filter(v => v.tipo === "GEN").length;
            const vociRED = (CONFIG.REDAZIONE || []).filter(v => v.tipo === "RED").length;
            
            log(`   ├─ 📅 Agenda: ${Object.keys(CONFIG.AGENDA || {}).length} voci`);
            log(`   ├─ 👥 Personaggi: ${numPersonaggi} (+ default)`);
            log(`   ├─ 📰 Redazione: ${numVoci} voci (RSS:${vociRSS}, GEN:${vociGEN}, RED:${vociRED})`);
            log(`   ├─ ⏰ Fasce orarie: ${fasceOrarie.length ? fasceOrarie.join(", ") : "sempre"}`);
            log(`   ├─ 📏 Lunghezza articoli: livello ${limiti.lunghezza_articolo || 5} (~${80 + ((limiti.lunghezza_articolo||5)-1)*80} parole)`);
            log(`   ├─ 💬 Commenti: min ${limiti.commenti_min || 1}, max ${limiti.commenti_max || 3}, totali max ${limiti.commenti_max_totali || 6}`);
            log(`   ├─ 🔄 Reset quote: ore ${limiti.fascia_reset_quote || "05"} (toll. ${limiti.tolleranza_minuti || 30} min)`);
            log(`   ├─ 🤖 Modelli: cerca max ${limiti.cerca_modello_max || 1} volte/giorno`);
            log(`   └─ 🎛️ Limiti: chat=${limiti.chat || "sempre"}, commenti=${limiti.commenti || "sempre"}, relazioni=${limiti.relazioni || "sempre"}`);
            
            // Ticker news (prime 2)
            const ticker = impostazioni.ticker_news || [];
            if (ticker.length) {
                const preview = ticker.slice(0, 2).map(t => t.length > 40 ? t.substring(0, 40) + "…" : t);
                log(`   └─ 📢 Ticker: ${preview.join(" | ")}${ticker.length > 2 ? ` +${ticker.length-2}` : ""}`);
            }
            
            // Personaggi principali (primi 5)
            const personaggiTop = Object.entries(CONFIG.CHI || {})
                .filter(([k]) => k !== "default")
                .slice(0, 5)
                .map(([k, v]) => `${k}(${v.avatar || "👤"})`);
            if (personaggiTop.length) {
                log(`   └─ 👤 Personaggi: ${personaggiTop.join(", ")}${numPersonaggi > 5 ? ` +${numPersonaggi-5}` : ""}`);
            }
            
        } else {
            log(`⚠️ Config vuota o non trovata: ${CONFIG_PATH}`);
        }
    }
    return CONFIG;
}

export function getVociAttive(oggi) {
    const { REDAZIONE } = loadConfig();
    if (!REDAZIONE) return [];
    return REDAZIONE.filter(voce => {
        if (voce.g === "default") return true;
        return voce.g.split(",").map(g => g.trim()).includes(oggi);
    });
}
