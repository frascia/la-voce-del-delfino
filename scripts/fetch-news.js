#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// --- CONFIGURAZIONE PERCORSI ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- COSTANTI E SEGRETI ---
const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto impostato.";

let activeGeminiModel = "gemini-1.5-flash";

function scriviLog(msg) {
    // Forziamo il fuso orario italiano per i log!
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const riga = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

/**
 * Cerca dinamicamente l'ULTIMA API di Gemini disponibile per la tua chiave
 */
async function trovaUltimoModello() {
    if (!apiKey) return;
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.models) {
            const modelliValidi = data.models
                .filter(m => m.name.includes("gemini") && m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            
            const modelliFlash = modelliValidi.filter(m => m.includes("flash"));
            modelliFlash.sort((a, b) => b.localeCompare(a));
            
            if (modelliFlash.length > 0) {
                activeGeminiModel = modelliFlash[0];
            } else if (modelliValidi.length > 0) {
                modelliValidi.sort((a, b) => b.localeCompare(a));
                activeGeminiModel = modelliValidi[0];
            }
        }
    } catch (e) {
        scriviLog(`[ATTENZIONE] Ricerca modelli fallita. Uso modello di riserva.`);
    }
}

/**
 * Pesca i titoli reali da Google News - SOLO NOTIZIE FRESCHE (Max 48 ore)
 */
async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        const titles = [];
        
        const dueGiorniFa = Date.now() - (2 * 24 * 60 * 60 * 1000);
        
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let matchItem;
        
        while ((matchItem = itemRegex.exec(xml)) !== null && titles.length < max) {
            const itemXml = matchItem[1];
            
            const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (pubDateMatch) {
                const dataNotizia = new Date(pubDateMatch[1]).getTime();
                if (dataNotizia < dueGiorniFa) {
                    continue; 
                }
            }
            
            const titleMatch = itemXml.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) {
                let cleanTitle = titleMatch[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
                cleanTitle = cleanTitle.split(" - ")[0].trim();
                
                if (!titles.includes(cleanTitle)) {
                    titles.push(cleanTitle);
                }
            }
        }
        return titles;
    } catch (e) {
        scriviLog(`Errore RSS per ${query}: ${e.message}`);
        return [];
    }
}

/**
 * Chiama l'API Dinamica con filtri di censura spenti
 */
async function callGemini(sys, prompt) {
    if (!apiKey) {
        scriviLog("ERRORE: Manca la GEMINI_API_KEY nei Secrets di GitHub!");
        return null;
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKey}`;
    
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
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
                scriviLog(`[ERRORE API GEMINI] ${d.error.message}`);

                // Se l'errore è di quota, aspetta e riprova il ciclo
               if (d.error) {
    const msg = d.error.message.toLowerCase();
    
    // CASO A: Quota Giornaliera (Blocco totale)
    if (msg.includes("per day") || msg.includes("limit: 500")) {
        scriviLog("❌ [QUOTA GIORNALIERA ESAURITA] Inutile riprovare, ci vediamo domani.");
        return null; // Esci subito dal ciclo, non serve aspettare 30s
    }

    // CASO B: Quota al Minuto (Blocco temporaneo)
    if (d.error.code === 429 || msg.includes("quota")) {
        const msAttesa = Math.pow(2, i) * 30000;
        scriviLog(`⏳ [LIMITE AL MINUTO] Attendo ${msAttesa / 1000}s...`);
        await new Promise(r => setTimeout(r, msAttesa));
        continue;
    }
    
    return null;
}

{
            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (!text) {
                return null;
            }
            return text;
            
       
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
    
    await trovaUltimoModello();
    scriviLog(`🤖 Modello Dinamico Agganciato: [ ${activeGeminiModel} ]`);
    
    // Forziamo il fuso orario di Roma anche per calcolare se è Lunedì, Martedì, ecc.
    const fusoItalia = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const dataOggiItalia = new Date(fusoItalia);
    const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const oggi = giorni[dataOggiItalia.getDay()];
    
    let currentConfigPath = path.join(DATA_DIR, `config_${oggi}.json`);
    
    if (!fs.existsSync(currentConfigPath)) {
        currentConfigPath = CONFIG_PATH;
    }

    if (!fs.existsSync(currentConfigPath)) {
        scriviLog(`ERRORE: ${currentConfigPath} non trovato!`);
        return;
    }

    const CONFIG = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));
    
    // Forziamo il fuso orario italiano per l'etichetta "Ultimo aggiornamento"
    const oraAggiornamento = new Date().toLocaleString('it-IT', { 
        timeZone: 'Europe/Rome', 
        hour: '2-digit', 
        minute: '2-digit', 
        day: '2-digit', 
        month: '2-digit' 
    });
    
    CONFIG.site_settings.last_update = oraAggiornamento;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = Buffer.from(secretData).toString('base64'); 
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: encrypted, ts: oraAggiornamento }));

    const sysPromptSatira = "Sei un giornalista satirico pescarese. Rispondi restituendo UN SINGOLO OGGETTO JSON ESATTO. Formato obbligatorio: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}. REQUISITO FONDAMENTALE: Il testo nel campo 'articolo' deve essere lungo, corposo e ben articolato (almeno 800-1000 caratteri), sviluppando la notizia con ricchezza di dettagli e umorismo assurdo.";
    
    const sysPromptVera = "Sei un giornalista serio, fattuale e oggettivo. Rispondi restituendo UN SINGOLO OGGETTO JSON ESATTO. Formato obbligatorio: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}. REQUISITO FONDAMENTALE: Il testo nel campo 'articolo' deve essere lungo, VERO, professionale e ben articolato (almeno 800-1000 caratteri), basandoti unicamente sui fatti reali forniti. Niente invenzioni o satira nell'articolo. Il 'commento' finale del Delfino può invece avere un tono saggio o ironico.";

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
        
        let quotaAvanzata = 0;

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;

            const targetPezzi = info.count + quotaAvanzata;
            quotaAvanzata = 0;

            scriviLog(`Lancio le reti per: ${nome} (Quota: ${info.count} + ${targetPezzi - info.count} recuperati = ${targetPezzi} totali)`);
            
            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Alieni a Pescara", "Arrosticini"];
                for (let i = 0; i < targetPezzi; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(sysPromptSatira, `Inventa una notizia assurda su: ${tema}.`);
                    const p = parseJSON(raw);
                    
                    if (p) {
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img, is_satira: true });
                    } else {
                        newsSezione.push({
                            titolo: `Mistero su: ${tema}`,
                            articolo: `Avevamo in serbo uno scoop clamoroso su "${tema}", ma un gabbiano ci ha rubato gli appunti.`,
                            commento: scuseDelfino[Math.floor(Math.random() * scuseDelfino.length)],
                            categoria: info.label,
                            immagine: info.img,
                            is_satira: true
                        });
                    }
                }
            } else {
                const titoli = await fetchRSS(nome, targetPezzi);
                
                if (titoli.length < targetPezzi) {
                    quotaAvanzata = targetPezzi - titoli.length;
                    scriviLog(`[SISTEMA A CASCATA] Trovate solo ${titoli.length} notizie fresche per ${nome}. Passo ${quotaAvanzata} reti alla categoria successiva!`);
                }

                for (const t of titoli) {
                    const raw = await callGemini(sysPromptVera, `Scrivi un articolo giornalistico VERO e dettagliato basato su questa news reale: ${t}`);
                    const p = parseJSON(raw);
                    
                    if (p) {
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img });
                    } else {
                        newsSezione.push({
                            titolo: t,
                            articolo: `Notizia battuta dalle agenzie: "${t}". L'Intelligenza Artificiale è in pausa caffè.`,
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
        scriviLog(`Sezione ${sez}: ${newsSezione.length} notizie pescate e confezionate.`);
    }
    
    scriviLog("🏁 Turno completato con successo.");
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
