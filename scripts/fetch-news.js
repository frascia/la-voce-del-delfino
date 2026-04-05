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
const adminPwd = process.env.ADMIN_PASSWORD || "delfino-admin";
const secretData = process.env.ADMIN_SECRET_DATA || "";

// Calcolo del giorno della settimana
const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const oggi = giorni[new Date().getDay()];

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT');
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
    console.log(`> ${msg}`);
}

async function callGemini(system, prompt, temp) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
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
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) { return null; }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it`;
    try {
        const res = await fetch(url);
        const xml = await res.text();
        const titles = [];
        const regex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        let m;
        while ((m = regex.exec(xml)) !== null && titles.length < max) { titles.push(m[1]); }
        return titles;
    } catch { return []; }
}

async function main() {
    scriviLog(`Inizio turno. Oggi è ${oggi.toUpperCase()}.`);

    let configPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(configPath)) {
        scriviLog(`Configurazione specifica per ${oggi} non trovata. Uso default.`);
        configPath = path.join(DATA_DIR, "config.json");
    }

    const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Salviamo il piano attivo per il sito
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG));
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ 
        key: adminPwd, 
        secrets: secretData.split('|').map(s => s.trim()), 
        updated: new Date().toLocaleString() 
    }));

    for (const k of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(k)) continue;
        let allNews = [];
        const sezConf = CONFIG[k];

        for (const [query, s] of Object.entries(sezConf)) {
            if (query === "color" || s.count <= 0) continue;

            if (s.label === "Satira") {
                for (let i = 0; i < s.count; i++) {
                    const tema = CONFIG.satira_config.temi[Math.floor(Math.random() * CONFIG.satira_config.temi.length)];
                    const raw = await callGemini("Autore satirico JSON.", `Tema: ${tema}`, s.weight);
                    if (raw) { try { allNews.push({ ...JSON.parse(raw), categoria: s.label, immagine: s.img, isFake: true, mood: s.mood }); } catch { i--; } }
                }
            } else {
                const titles = await fetchRSS(query, s.count);
                if (titles.length > 0) {
                    const raw = await callGemini(`Giornalista ${s.mood} JSON.`, `Titoli: ${titles.join('\n')}`, s.weight);
                    if (raw) { try { allNews.push(...JSON.parse(raw).map(n => ({ ...n, categoria: s.label, immagine: s.img, isFake: false, mood: s.mood }))); } catch {} }
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${k}.json`), JSON.stringify({ color: sezConf.color, news: allNews }));
    }
    scriviLog("Turno completato.");
}
main();
