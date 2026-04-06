#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ==========================================
// 🛠 PARAMETRI MANUALI (Modificali qui)
// ==========================================
const LIMITE_ORE = 24;            // Solo notizie ultime 24 ore
const PAUSA_TRA_ARTICOLI = 3000;  // 3 secondi di attesa (velocizza il turno)
const LUNGHEZZA_MINIMA = 800;     // Caratteri minimi per articolo
// ==========================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(BASE_DIR, "public", "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto.";
let activeGeminiModel = "gemini-1.5-flash";

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
    console.log(`> ${msg}`);
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    // Aggiungiamo when:24h per forzare Google a darci solo roba nuova
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:${LIMITE_ORE}h&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        const xml = await res.text();
        const titles = [];
        const oraLimite = Date.now() - (LIMITE_ORE * 60 * 60 * 1000);
        
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && titles.length < max) {
            const item = m[1];
            const dM = item.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (dM && new Date(dM[1]).getTime() < oraLimite) continue; // Filtro manuale tempo
            
            const tM = item.match(/<title>(.*?)<\/title>/i);
            if (tM) {
                const t = tM[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").split(" - ")[0].trim();
                if (!titles.includes(t)) titles.push(t);
            }
        }
        return titles;
    } catch (e) { return []; }
}

async function callGemini(sys, prompt) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKey}`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: sys }] },
                generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
            })
        });
        const d = await res.json();
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        return text ? JSON.parse(text) : null;
    } catch (e) { return null; }
}

async function main() {
    scriviLog(`🚀 Inizio turno (Filtro: ${LIMITE_ORE}h)`);
    
    const fuso = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const oggi = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'][new Date(fuso).getDay()];
    let cfgP = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(cfgP)) cfgP = CONFIG_PATH;
    const CONFIG = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' });
    CONFIG.site_settings.last_update = ts;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: crypto.createHash('sha256').update(adminPwd).digest('hex'), data: Buffer.from(secretData).toString('base64'), ts }));

    const sysSat = `Giornalista satirico. JSON {titolo, articolo, commento}. Articolo > ${LUNGHEZZA_MINIMA} car.`;
    const sysVer = `Giornalista serio. JSON {titolo, articolo, commento}. Articolo VERO > ${LUNGHEZZA_MINIMA} car.`;

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        
        let newsSezione = [];
        const categorie = CONFIG[sez];
        let quotaAvanzata = 0; 

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count === undefined) continue;
            const target = info.count + quotaAvanzata;
            quotaAvanzata = 0;

            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Delfini"];
                for (let i = 0; i < target; i++) {
                    const r = await callGemini(sysSat, `Scoop su: ${temi[Math.floor(Math.random()*temi.length)]}`);
                    if (r) newsSezione.push({ ...r, categoria: info.label, immagine: info.img, is_satira: true });
                    await new Promise(r => setTimeout(r, PAUSA_TRA_ARTICOLI));
                }
            } else {
                const tits = await fetchRSS(nome, target);
                if (tits.length < target) quotaAvanzata = target - tits.length;

                for (const t of tits) {
                    scriviLog(`Scrittura: ${t.substring(0, 30)}...`);
                    const r = await callGemini(sysVer, `Articolo su: ${t}`);
                    if (r) newsSezione.push({ ...r, categoria: info.label, immagine: info.img });
                    await new Promise(r => setTimeout(r, PAUSA_TRA_ARTICOLI));
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${sez}.json`), JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
    }
    scriviLog("🏁 Fine turno.");
}

main().catch(e => scriviLog(`Errore: ${e.message}`));