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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun segreto impostato.";
let activeGeminiModel = "gemini-1.5-flash";

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
    console.log(`> ${msg}`);
}

async function trovaUltimoModello() {
    if (!apiKey) return;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        if (data.models) {
            const validi = data.models
                .filter(m => m.name.includes("gemini") && m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            // Usiamo 1.5-flash che è il più stabile per i limiti di quota
            activeGeminiModel = validi.find(m => m === "gemini-1.5-flash") || validi[0] || activeGeminiModel;
        }
    } catch (e) { scriviLog("Errore ricerca modelli."); }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        const xml = await res.text();
        const titles = [];
        const limite = Date.now() - (48 * 60 * 60 * 1000); // 48 ore rigide
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && titles.length < max) {
            const item = m[1];
            const dM = item.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (dM && new Date(dM[1]).getTime() < limite) continue;
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
    
    for (let i = 0; i < 5; i++) {
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

            if (d.error) {
                if (d.error.message.includes("quota")) {
                    const attesa = (i + 1) * 15; // Aspetta 15, 30, 45... secondi
                    scriviLog(`Quota piena. Attendo ${attesa} secondi prima di riprovare...`);
                    await new Promise(r => setTimeout(r, attesa * 1000));
                    continue;
                }
                return null;
            }

            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return JSON.parse(text);
        } catch (e) { 
            await new Promise(r => setTimeout(r, 5000)); 
        }
    }
    return null;
}

async function main() {
    scriviLog("⚓️ Inizio turno di redazione...");
    await trovaUltimoModello();
    scriviLog(`🤖 Modello: ${activeGeminiModel}`);
    
    const fuso = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const oggi = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'][new Date(fuso).getDay()];
    let cfgP = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(cfgP)) cfgP = CONFIG_PATH;
    const CONFIG = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' });
    CONFIG.site_settings.last_update = ts;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: crypto.createHash('sha256').update(adminPwd).digest('hex'), data: Buffer.from(secretData).toString('base64'), ts }));

    const sysSat = "Sei un giornalista satirico pescarese. JSON: {titolo, articolo, commento}. Articolo lungo (1000+ caratt).";
    const sysVer = "Sei un giornalista serio. JSON: {titolo, articolo, commento}. Articolo VERO lungo (1000+ caratt).";

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
                const temi = CONFIG.satira_config?.temi || ["Delfino"];
                for (let i = 0; i < target; i++) {
                    const r = await callGemini(sysSat, `Scoop su: ${temi[Math.floor(Math.random()*temi.length)]}`);
                    if (r) newsSezione.push({ ...r, categoria: info.label, immagine: info.img, is_satira: true });
                    // Pausa tattica anti-quota
                    await new Promise(r => setTimeout(r, 8000));
                }
            } else {
                const tits = await fetchRSS(nome, target);
                if (tits.length < target) quotaAvanzata = target - tits.length;

                for (const t of tits) {
                    scriviLog(`Scrivo pezzo per: ${t}`);
                    const r = await callGemini(sysVer, `Articolo su: ${t}`);
                    if (r) newsSezione.push({ ...r, categoria: info.label, immagine: info.img });
                    // Pausa tattica anti-quota
                    await new Promise(r => setTimeout(r, 8000));
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${sez}.json`), JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
        scriviLog(`✅ Sezione ${sez} completata: ${newsSezione.length} articoli.`);
    }
    scriviLog("🏁 Turno completato.");
}

main().catch(e => scriviLog(`Errore: ${e.message}`));