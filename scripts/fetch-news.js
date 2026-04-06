#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

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
            const flash = validi.filter(m => m.includes("flash")).sort((a, b) => b.localeCompare(a));
            activeGeminiModel = flash[0] || validi[0] || activeGeminiModel;
        }
    } catch (e) { scriviLog("Errore ricerca modelli."); }
}

function pulisciEParseJSON(raw) {
    try {
        if (!raw) return null;
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1) return null;
        return JSON.parse(raw.substring(start, end + 1));
    } catch (e) { return null; }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        const xml = await res.text();
        const titles = [];
        const limite = Date.now() - (2 * 24 * 60 * 60 * 1000);
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
        } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    return null;
}

async function main() {
    scriviLog("⚓️ Inizio turno...");
    await trovaUltimoModello();
    
    const fuso = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const oggi = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'][new Date(fuso).getDay()];
    let cfgP = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(cfgP)) cfgP = CONFIG_PATH;
    const CONFIG = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' });
    CONFIG.site_settings.last_update = ts;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: crypto.createHash('sha256').update(adminPwd).digest('hex'), data: Buffer.from(secretData).toString('base64'), ts }));

    const sysSat = "Sei un giornalista satirico. JSON: {titolo, articolo, commento}. Articolo LUNGO (1000 caratt).";
    const sysVer = "Sei un giornalista serio. JSON: {titolo, articolo, commento}. Articolo LUNGO (1000 caratt), VERO.";

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        let newsSezione = [];
        const categorie = CONFIG[sez];
        let quota = 0;

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;
            const target = info.count + quota;
            quota = 0;

            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Delfini"];
                for (let i = 0; i < target; i++) {
                    const r = await callGemini(sysSat, `Scoop su: ${temi[Math.floor(Math.random()*temi.length)]}`);
                    const p = pulisciEParseJSON(r);
                    if (p) newsSezione.push({ ...p, categoria: info.label, immagine: info.img, is_satira: true });
                }
            } else {
                const tits = await fetchRSS(nome, target);
                if (tits.length < target) quota = target - tits.length;
                for (const t of tits) {
                    const r = await callGemini(sysVer, `Articolo VERO su: ${t}`);
                    const p = pulisciEParseJSON(r);
                    if (p) newsSezione.push({ ...p, categoria: info.label, immagine: info.img });
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${sez}.json`), JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
        scriviLog(`Scritto news-${sez}.json con ${newsSezione.length} articoli.`);
    }
    scriviLog("🏁 Turno completato.");
}

main().catch(e => scriviLog(`Errore: ${e.message}`));