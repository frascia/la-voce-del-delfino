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
        scriviLog(`[ATTENZIONE] Ricerca modelli fallita. Uso modello di riserva.`);
    }
}

/**
 * Tenta di scaricare i titoli attualmente online per il confronto
 */
async function recuperaTitoliOnline(sezione) {
    // Costruiamo l'URL basandoci sulle info di GitHub (se disponibili)
    const repo = process.env.GITHUB_REPOSITORY; // Es: "user/repo"
    if (!repo) return [];
    
    const [user, name] = repo.split('/');
    const url = `https://${user}.github.io/${name}/public/data/news-${sezione}.json`;
    
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return data.news ? data.news.map(n => n.titolo.trim().toLowerCase()) : [];
    } catch (e) {
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
        let matchItem;
        while ((matchItem = itemRegex.exec(xml)) !== null && titles.length < max) {
            const itemXml = matchItem[1];
            const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (!pubDateMatch) continue;
            const dataNotizia = new Date(pubDateMatch[1]).getTime();
            if (isNaN(dataNotizia) || dataNotizia < dueGiorniFa) continue;
            const titleMatch = itemXml.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) {
                let cleanTitle = titleMatch[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
                cleanTitle = cleanTitle.split(" - ")[0].trim();
                if (!titles.includes(cleanTitle)) titles.push(cleanTitle);
            }
        }
        return titles;
    } catch (e) {
        scriviLog(`Errore RSS per ${query}: ${e.message}`);
        return [];
    }
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
                            properties: {
                                titolo: { type: "STRING" },
                                articolo: { type: "STRING" },
                                commento: { type: "STRING" }
                            },
                            required: ["titolo", "articolo", "commento"]
                        }
                    },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
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

function parseJSON(raw) {
    try {
        if (!raw) return null;
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start !== -1 && end !== -1) return JSON.parse(raw.substring(start, end + 1));
        return null;
    } catch (e) { return null; }
}

async function main() {
    scriviLog("⚓️ Inizio turno di redazione...");
    await trovaUltimoModello();
    
    const fusoItalia = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const dataOggiItalia = new Date(fusoItalia);
    const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const oggi = giorni[dataOggiItalia.getDay()];
    
    let currentConfigPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(currentConfigPath)) currentConfigPath = CONFIG_PATH;
    const CONFIG = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));
    
    const oraAggiornamento = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    CONFIG.site_settings.last_update = oraAggiornamento;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = Buffer.from(secretData).toString('base64'); 
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: encrypted, ts: oraAggiornamento }));

    const sysPromptSatira = "Sei un giornalista satirico pescarese. Restituisci JSON con chiavi 'titolo', 'articolo', 'commento'. Articolo 800+ caratt.";
    const sysPromptVera = "Sei un giornalista serio. Restituisci JSON con chiavi 'titolo', 'articolo', 'commento'. Articolo VERO 800+ caratt.";

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        
        // RECUPERO TITOLI ONLINE PER CONFRONTO REALE
        const titoliOnline = await recuperaTitoliOnline(sez);
        scriviLog(`Confronto con ${titoliOnline.length} titoli già pubblicati online per la sezione ${sez}.`);

        let newsSezione = [];
        const categorie = CONFIG[sez];
        let quotaAvanzata = 0;

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;
            const targetPezzi = info.count + quotaAvanzata;
            quotaAvanzata = 0;

            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Alieni"];
                for (let i = 0; i < targetPezzi; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(sysPromptSatira, `Scoop su: ${tema}.`);
                    const p = parseJSON(raw);
                    if (p && p.articolo) {
                        const isNew = !titoliOnline.includes(p.titolo.trim().toLowerCase());
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img, is_satira: true, is_new: isNew });
                    }
                }
            } else {
                const titoli = await fetchRSS(nome, targetPezzi);
                if (titoli.length < targetPezzi) quotaAvanzata = targetPezzi - titoli.length;
                for (const t of titoli) {
                    const raw = await callGemini(sysPromptVera, `Articolo su: ${t}`);
                    const p = parseJSON(raw);
                    if (p && p.articolo) {
                        const isNew = !titoliOnline.includes(p.titolo.trim().toLowerCase());
                        newsSezione.push({ ...p, categoria: info.label, immagine: info.img, is_new: isNew });
                    }
                }
            }
        }
        const outPath = path.join(DATA_DIR, `news-${sez}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
    }
    scriviLog("🏁 Turno completato.");
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});