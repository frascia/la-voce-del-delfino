#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data"); 
const LOG_PATH  = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "admin-delfino";
const secretData = process.env.ADMIN_SECRET_DATA || "";

const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const oggi = giorni[new Date().getDay()];

let activeModel = "gemini-1.5-flash"; // Modello di salvataggio

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT');
    const logLine = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, logLine);
    console.log(`> ${msg}`);
}

// -----------------------------------------------------
// 1. IL CERVELLO: AUTO-DISCOVERY DEL MODELLO
// -----------------------------------------------------
async function autoDiscoverModel() {
    scriviLog("🔍 Controllo Radar: Ricerca dell'ultimo modello Gemini disponibile...");
    if (!apiKey) return;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!res.ok) throw new Error(`API Status: ${res.status}`);
        
        const data = await res.json();
        
        const flashModels = data.models
            .filter(m => m.name.includes('flash') && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));

        if (flashModels.length > 0) {
            const latest = flashModels.sort().reverse()[0]; 
            activeModel = latest;
            scriviLog(`✅ Radar completato. Agganciato modello: ${activeModel}`);
        } else {
            scriviLog(`⚠️ Radar a vuoto. Uso modello di riserva: ${activeModel}`);
        }
    } catch (e) {
        scriviLog(`⚠️ Errore Radar (${e.message}). Uso modello base: ${activeModel}`);
    }
}

// -----------------------------------------------------
// 2. LO SCUDO: PARSER JSON INDISTRUTTIBILE
// -----------------------------------------------------
function parseNews(raw) {
    if (!raw) return [];
    try {
        let clean = raw.replace(/`{3}(?:json|html|xml)?\n/gi, "").replace(/`{3}/g, "").trim();
        let start = Math.min(...[clean.indexOf('['), clean.indexOf('{')].filter(i => i !== -1));
        let end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
        
        if (start !== -1 && end !== -1) {
            return JSON.parse(clean.substring(start, end + 1));
        }
        throw new Error("Parentesi mancanti nel JSON");
    } catch (e) {
        scriviLog(`❌ Errore critico lettura dati di Gemini: ${e.message}`);
        return []; 
    }
}

async function callGemini(system, prompt, temp) {
    if (!apiKey) {
        scriviLog("❌ ERRORE: Chiave Motore (API_KEY) mancante.");
        return null;
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;
    
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: system }] },
                generationConfig: { responseMimeType: "application/json", temperature: parseFloat(temp) }
            })
        });
        
        if (!res.ok) {
            const errorText = await res.text();
            scriviLog(`❌ ERRORE API GOOGLE (${res.status}): ${errorText}`);
            return null;
        }

        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) { 
        scriviLog(`❌ ERRORE DI RETE GEMINI: ${e.message}`);
        return null; 
    }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    scriviLog(`🔍 Ricerca RSS in corso per: ${query}...`);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it`;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        
        if (!res.ok) {
            scriviLog(`❌ ERRORE RSS GOOGLE NEWS: ${res.status}`);
            return [];
        }
        
        const xml = await res.text();
        const titles = [];
        
        const regex = /<item>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/gi;
        let m;
        
        while ((m = regex.exec(xml)) !== null && titles.length < max) { 
            let cleanTitle = m[1].replace(/<!\[CDATA\[|\]\]>/gi, '').trim();
            titles.push(cleanTitle); 
        }
        
        scriviLog(`✅ Trovati ${titles.length} articoli per ${query}.`);
        return titles;
    } catch(e) { 
        scriviLog(`❌ ERRORE DI RETE RSS: ${e.message}`);
        return []; 
    }
}

async function main() {
    scriviLog(`⚓️ Inizio turno. Oggi è ${oggi.toUpperCase()}.`);

    await autoDiscoverModel();

    let configPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(configPath)) {
        scriviLog(`Nessun ordine speciale per oggi (${oggi}). Uso config.json di default.`);
        configPath = path.join(DATA_DIR, "config.json");
    }

    const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ 
        key: adminPwd, 
        secrets: secretData.split('|').map(s => s.trim()), 
        updated: new Date().toLocaleString() 
    }));

    for (const k of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(k)) continue;
        let allNews = [];
        const sezConf = CONFIG[k];

        scriviLog(`\n🌊 Esplorazione Zona: ${k.toUpperCase()}`);

        for (const [query, s] of Object.entries(sezConf)) {
            if (query === "color" || s.count <= 0) continue;

            if (s.label === "Satira") {
                for (let i = 0; i < s.count; i++) {
                    const tema = CONFIG.satira_config.temi[Math.floor(Math.random() * CONFIG.satira_config.temi.length)];
                    scriviLog(`📝 Affido Satira a Gemini... Tema: ${tema}`);
                    const raw = await callGemini(
                        "Sei un autore satirico. Rispondi SOLO in JSON con questo formato: {\"titolo\":\"...\",\"sommario\":\"...\",\"commento\":\"...\"}", 
                        `Scrivi una fake news satirica a tema Pescara. Il campo 'sommario' deve essere un vero articolo lungo e dettagliato, non un testo corto. Tema: ${tema}`, 
                        s.weight
                    );
                    
                    const parsedData = parseNews(raw);
                    if (parsedData && !Array.isArray(parsedData) && parsedData.titolo) { 
                        allNews.push({ ...parsedData, categoria: s.label, immagine: s.img, isFake: true, mood: s.mood }); 
                        scriviLog(`✅ Satira generata e imbarcata.`);
                    } else {
                        scriviLog(`⚠️ Riprovo satira per errore formato...`);
                        i--; 
                    }
                }
            } else {
                const titles = await fetchRSS(query, s.count);
                if (titles.length > 0) {
                    scriviLog(`🤖 Invio titoli a Gemini (Stile: ${s.mood})...`);
                    const raw = await callGemini(
                        `Sei un giornalista ${s.mood}. Rispondi SOLO in formato ARRAY JSON: [{"titolo":"...","sommario":"...","commento":"..."}]`, 
                        `Rielabora questi titoli di notizie scrivendo nel campo 'sommario' un vero e proprio articolo lungo e ricco di dettagli, non un testo corto. Aggiungi anche un 'commento' più lungo e discorsivo in stile giornalista. Titoli:\n${titles.join('\n')}`, 
                        s.weight
                    );
                    
                    const parsedArray = parseNews(raw);
                    if (Array.isArray(parsedArray) && parsedArray.length > 0) {
                        allNews.push(...parsedArray.map(n => ({ ...n, categoria: s.label, immagine: s.img, isFake: false, mood: s.mood }))); 
                        scriviLog(`✅ Notizie elaborate per ${query}.`);
                    } else {
                        scriviLog(`❌ Gemini ha restituito un formato illeggibile per ${query}.`);
                    }
                } else {
                    scriviLog(`⚠️ Nessuna novità all'orizzonte per ${query}.`);
                }
            }
        }
        
        fs.writeFileSync(path.join(DATA_DIR, `news-${k}.json`), JSON.stringify({ today: new Date().toLocaleDateString('it-IT', {weekday:'long', day:'numeric', month:'long'}), color: sezConf.color, news: allNews }, null, 2));
    }
    scriviLog("🏁 Turno completato. Nave in porto.");
}

main();
