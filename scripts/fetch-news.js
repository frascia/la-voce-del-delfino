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
 * Pesca i titoli reali da Google News (Aggiornato per nuovo formato RSS)
 */
async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        const titles = [];
        
        // Nuova RegEx che cerca il <title> dentro i vari <item>, ignorando CDATA se non c'è
        const regex = /<item>[\s\S]*?<title>(.*?)<\/title>/gi;
        let m;
        while ((m = regex.exec(xml)) !== null && titles.length < max) {
            let cleanTitle = m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
            cleanTitle = cleanTitle.split(" - ")[0].trim();
            titles.push(cleanTitle);
        }
        return titles;
    } catch (e) {
        scriviLog(`Errore RSS per ${query}: ${e.message}`);
        return [];
    }
}

/**
 * Chiama Gemini API con L'ULTIMO MODELLO DISPONIBILE e filtri di censura spenti
 */
async function callGemini(sys, prompt) {
    if (!apiKey) {
        scriviLog("ERRORE: Manca la GEMINI_API_KEY nei Secrets di GitHub!");
        return null;
    }
    // L'ultimissima versione disponibile
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
                    // Spegniamo i filtri di sicurezza che bloccano la satira
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });
            const d = await res.json();

            if (d.error) {
                scriviLog(`[ERRORE API GEMINI] Google ha rifiutato la richiesta: ${d.error.message}`);
                return null; 
            }

            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (!text) {
                const motivo = d.candidates?.[0]?.finishReason || "Sconosciuto";
                scriviLog(`[ATTENZIONE] Gemini ha restituito vuoto. FinishReason: ${motivo}`);
                return null;
            }
            return text;
            
        } catch (e) {
            await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        }
    }
    return null;
}

/**
 * Pulisce il JSON in modo chirurgico
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
    
    CONFIG.site_settings.last_update = oraAggiornamento;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = Buffer.from(secretData).toString('base64'); 
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: encrypted, ts: oraAggiornamento }));

    const sysPrompt = "Sei un giornalista satirico pescarese. Rispondi restituendo UN SINGOLO OGGETTO JSON ESATTO. Formato obbligatorio: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}";

    // Scuse automatiche in caso di sciopero dell'AI
    const scuseDelfino = [
        "Il Delfino è in sciopero per carenza di arrosticini.",
        "Lo stagista ha rovesciato la genziana sul server del sito.",
        "Notizia troppo assurda perfino per noi, ci asteniamo.",
        "La nostra Intelligenza Artificiale è andata a farsi il bagno a Pescara Vecchia."
    ];

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
                    
                    if (p) {
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img });
                    } else {
                        // PIANO B: Gemini non ha risposto alla satira
                        scriviLog(`[PIANO B] Inserisco scusa di sciopero per la satira su: ${tema}`);
                        newsSezione.push({
                            titolo: `Mistero su: ${tema}`,
                            articolo: `Avevamo in serbo uno scoop clamoroso su "${tema}", ma un gabbiano gigante ci ha rubato gli appunti mentre mangiavamo un calzone al porto. La redazione è attualmente all'inseguimento del volatile.`,
                            commento: scuseDelfino[Math.floor(Math.random() * scuseDelfino.length)],
                            categoria: info.label,
                            immagine: info.img
                        });
                    }
                }
            } else {
                const titoli = await fetchRSS(nome, info.count);
                if (titoli.length === 0) titoli.push(nome);

                for (const t of titoli) {
                    const raw = await callGemini(sysPrompt, `Articolo satirico basato su questa news reale: ${t}`);
                    const p = parseJSON(raw);
                    
                    if (p) {
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img });
                    } else {
                        // PIANO B: Gemini non ha risposto alla notizia vera
                        scriviLog(`[PIANO B] Inserisco notizia reale grezza per: ${t}`);
                        newsSezione.push({
                            titolo: t,
                            articolo: `Notizia battuta dalle agenzie: "${t}". Purtroppo la nostra Intelligenza Artificiale si è rifiutata di commentare l'accaduto e ha richiesto un giorno di ferie anticipato. Rimanete sintonizzati.`,
                            commento: scuseDelfino[Math.floor(Math.random() * scuseDelfino.length)],
                            categoria: info.label,
                            immagine: info.img
                        });
                    }
                }
            }
        }
        
        const outPath = path.join(DATA_DIR, `news-${sez}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
        scriviLog(`Sezione ${sez}: ${newsSezione.length} notizie pescate e archiviate.`);
    }
    
    scriviLog("🏁 Turno completato con successo.");
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
