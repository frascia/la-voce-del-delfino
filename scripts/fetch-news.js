#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// --- CONFIGURAZIONE PERCORSI ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Saliamo di un livello per uscire da /scripts e trovare /public
const BASE_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

// Creazione cartella dati se mancante
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- COSTANTI E SEGRETI ---
const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto impostato.";

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT');
    const riga = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

/**
 * Pesca i titoli reali da Google News
 */
async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        const titles = [];
        const regex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        let m;
        while ((m = regex.exec(xml)) !== null && titles.length < max) {
            const cleanTitle = m[1].split(" - ")[0];
            titles.push(cleanTitle);
        }
        return titles;
    } catch (e) {
        scriviLog(`Errore RSS per ${query}: ${e.message}`);
        return [];
    }
}

/**
 * Chiama Gemini API con gestione errori
 */
async function callGemini(sys, prompt) {
    if (!apiKey) {
        scriviLog("ERRORE: Manca la GEMINI_API_KEY nei Secrets di GitHub!");
        return null;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature: 0.8 }
                })
            });
            const d = await res.json();
            return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
        } catch (e) {
            await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        }
    }
    return null;
}

/**
 * Pulisce il JSON ritagliando chirurgicamente solo i dati (ignora le chiacchiere dell'AI)
 */
function parseJSON(raw) {
    try {
        if (!raw) return null;
        
        // Trova la prima graffa aperta e l'ultima chiusa
        const inizio = raw.indexOf('{');
        const fine = raw.lastIndexOf('}');
        
        if (inizio !== -1 && fine !== -1 && fine >= inizio) {
            // Ritaglia esattamente il pezzo che ci serve
            const soloJSON = raw.substring(inizio, fine + 1);
            return JSON.parse(soloJSON);
        }
        
        scriviLog("Attenzione: Nessun blocco JSON trovato nella risposta di Gemini.");
        return null;
    } catch (e) {
        scriviLog("Errore parsing JSON: l'AI ha generato un formato illeggibile.");
        return null;
    }
}

async function main() {
    scriviLog("⚓️ Inizio turno di redazione (Fetch-News)...");
    
    const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const oggi = giorni[new Date().getDay()];
    let currentConfigPath = path.join(DATA_DIR, `config_${oggi}.json`);
    
    if (!fs.existsSync(currentConfigPath)) {
        currentConfigPath = CONFIG_PATH;
    }

    if (!fs.existsSync(currentConfigPath)) {
        scriviLog(`ERRORE: ${currentConfigPath} non trovato!`);
        return;
    }

    const CONFIG = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));
    const oraAggiornamento = new Date().toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    
    // Aggiornamento configurazione attiva
    CONFIG.site_settings.last_update = oraAggiornamento;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    // Sicurezza e Terminale
    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = Buffer.from(secretData).toString('base64'); 
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: encrypted, ts: oraAggiornamento }));

    const sysPrompt = "Sei un giornalista satirico pescarese. Rispondi SOLO in JSON: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}";

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        
        let newsSezione = [];
        const categorie = CONFIG[sez];

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;

            scriviLog(`Lancio le reti per: ${nome} (${info.count} pezzi)`);
            
            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Alieni a Pescara", "Arrosticini"];
                for (let i = 0; i < info.count; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(sysPrompt, `Inventa una notizia assurda su: ${tema}.`);
                    const p = parseJSON(raw);
                    if (p) newsSezione.push({ ...p, categoria: info.label, immagine: info.img });
                }
            } else {
                const titoli = await fetchRSS(nome, info.count);
                if (titoli.length === 0) titoli.push(nome);

                for (const t of titoli) {
                    const raw = await callGemini(sysPrompt, `Articolo satirico basato su questa news reale: ${t}`);
                    const p = parseJSON(raw);
                    if (p) newsSezione.push({ ...p, categoria: info.label, immagine: info.img });
                }
            }
        }
        
        const outPath = path.join(DATA_DIR, `news-${sez}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
        scriviLog(`Sezione ${sez}: ${newsSezione.length} notizie pescate.`);
    }
    
    scriviLog("🏁 Turno completato con successo.");
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
