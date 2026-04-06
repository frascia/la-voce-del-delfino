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

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto impostato.";

let activeGeminiModel = "gemini-1.5-flash";

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const riga = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

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
            if (modelliFlash.length > 0) activeGeminiModel = modelliFlash[0];
            else if (modelliValidi.length > 0) {
                modelliValidi.sort((a, b) => b.localeCompare(a));
                activeGeminiModel = modelliValidi[0];
            }
        }
    } catch (e) {
        scriviLog(`[ATTENZIONE] Ricerca modelli fallita.`);
    }
}

/**
 * Recupera i titoli pubblicati online per evitare falsi "NEW"
 */
async function recuperaTitoliOnline(sezione) {
    const repo = process.env.GITHUB_REPOSITORY; 
    if (!repo) return [];
    
    const [user, name] = repo.split('/');
    // Se il repository si chiama come la pagina (user.github.io), l'URL è diverso
    const baseUrl = (name === `${user}.github.io`) 
        ? `https://${user}.github.io` 
        : `https://${user}.github.io/${name}`;
    
    const url = `${baseUrl}/public/data/news-${sezione}.json?v=${Date.now()}`;
    
    try {
        scriviLog(`Controllo archivio online su: ${url}`);
        const res = await fetch(url);
        if (!res.ok) {
            scriviLog(`Archivio per ${sezione} non trovato (prima pubblicazione?)`);
            return [];
        }
        const data = await res.json();
        return data.news ? data.news.map(n => n.titolo.trim().toLowerCase()) : [];
    } catch (e) {
        scriviLog(`Errore connessione archivio online: ${e.message}`);
        return [];
    }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const queryFresca = `${query} when:2d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(queryFresca)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        const titles = [];
        const dueGiorniFa = Date.now() - (2 * 24 * 60 * 60 * 1000);
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && titles.length < max) {
            const item = m[1];
            const pMatch = item.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (!pMatch) continue;
            if (new Date(pMatch[1]).getTime() < dueGiorniFa) continue;
            const tMatch = item.match(/<title>(.*?)<\/title>/i);
            if (tMatch) {
                let t = tMatch[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").split(" - ")[0].trim();
                if (!titles.includes(t)) titles.push(t);
            }
        }
        return titles;
    } catch (e) { return []; }
}

async function callGemini(sys, prompt) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKey}`;
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { 
                        responseMimeType: "application/json", 
                        temperature: 0.8,
                        responseSchema: {
                            type: "OBJECT",
                            properties: { titolo: { type: "STRING" }, articolo: { type: "STRING" }, commento: { type: "STRING" } },
                            required: ["titolo", "articolo", "commento"]
                        }
                    },
                    safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }]
                })
            });
            const d = await res.json();
            return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
        } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    return null;
}

async function main() {
    scriviLog("⚓️ Apertura redazione...");
    await trovaUltimoModello();
    
    const fuso = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const oggiIdx = new Date(fuso).getDay();
    const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const oggi = giorni[oggiIdx];
    
    let cfgP = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(cfgP)) cfgP = CONFIG_PATH;
    const CONFIG = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' });
    CONFIG.site_settings.last_update = ts;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: Buffer.from(secretData).toString('base64'), ts }));

    const sysSat = "Sei un giornalista satirico pescarese. JSON con: titolo, articolo (800+ car.), commento. Sii assurdo.";
    const sysVer = "Sei un giornalista serio. JSON con: titolo, articolo (800+ car.), commento. Sii VERO e oggettivo.";

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        
        const titoliVivi = await recuperaTitoliOnline(sez);
        let newsSezione = [];
        const categorie = CONFIG[sez];
        let quota = 0;

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;
            const tPezzi = info.count + quota;
            quota = 0;

            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Delfini"];
                for (let i = 0; i < tPezzi; i++) {
                    const r = await callGemini(sysSat, `Scoop su: ${temi[Math.floor(Math.random()*temi.length)]}`);
                    const p = JSON.parse(r || "{}");
                    if (p.articolo) {
                        const isNew = titoliVivi.length > 0 && !titoliVivi.includes(p.titolo.trim().toLowerCase());
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img, is_satira: true, is_new: isNew });
                    }
                }
            } else {
                const tits = await fetchRSS(nome, tPezzi);
                if (tits.length < tPezzi) quota = tPezzi - tits.length;
                for (const t of tits) {
                    const r = await callGemini(sysVer, `Articolo su: ${t}`);
                    const p = JSON.parse(r || "{}");
                    if (p.articolo) {
                        const isNew = titoliVivi.length > 0 && !titoliVivi.includes(p.titolo.trim().toLowerCase());
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img, is_new: isNew });
                    }
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${sez}.json`), JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
    }
    scriviLog("🏁 Turno completato.");
}

main().catch(e => scriviLog(`Errore: ${e.message}`));