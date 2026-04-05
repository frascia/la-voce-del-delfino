#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../public/data");
const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino-default";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun dato segreto.";

const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const oggi = giorni[new Date().getDay()];

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT');
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
    console.log(`> ${msg}`);
}

function encrypt(text, key) {
    let result = "";
    for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return Buffer.from(result).toString('base64');
}

async function callGemini(system, prompt, temp) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    // Exponential backoff
    for (let i = 0; i < 5; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `[REF: ${Date.now()}] ` + prompt }] }],
                    systemInstruction: { parts: [{ text: system }] },
                    generationConfig: { responseMimeType: "application/json", temperature: parseFloat(temp) }
                })
            });
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text;
        } catch (e) {}
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
    return null;
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
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
    scriviLog(`⚓️ Turno avviato: ${oggi.toUpperCase()}`);
    
    let configPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(configPath)) configPath = path.join(DATA_DIR, "config.json");
    
    const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const updateTime = new Date().toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    
    CONFIG.site_settings.last_update = updateTime;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    // Sicurezza
    const pwdHash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encryptedVault = encrypt(secretData, adminPwd);
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: pwdHash, data: encryptedVault, ts: updateTime }));

    const SYSTEM_PROMPT = `Sei un redattore satirico pescarese. Genera JSON: {"titolo": "...", "articolo": "...", "commento": "...", "fonte": "..."}. Articolo > 600 car. Commento > 250 car.`;

    for (const k of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(k)) continue;
        let allNews = [];
        const sezConf = CONFIG[k];

        for (const [query, s] of Object.entries(sezConf)) {
            if (query === "color" || s.count <= 0) continue;

            if (s.label === "Satira") {
                const temi = CONFIG.satira_config.temi;
                for (let i = 0; i < s.count; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(SYSTEM_PROMPT, `INVENTA notizia assurda su: ${tema}`, s.weight);
                    if (raw) {
                        try {
                            const p = JSON.parse(raw.replace(/```json\n?|```/g, ""));
                            allNews.push({ ...p, categoria: s.label, immagine: s.img, isFake: true });
                        } catch(e) {}
                    }
                }
            } else {
                const titles = await fetchRSS(query, s.count);
                if (titles.length > 0) {
                    const raw = await callGemini(SYSTEM_PROMPT, `Analizza titoli news:\n${titles.join('\n')}`, s.weight);
                    if (raw) {
                        try {
                            const p = JSON.parse(raw.replace(/```json\n?|```/g, ""));
                            const items = Array.isArray(p) ? p : [p];
                            allNews.push(...items.map(n => ({ ...n, categoria: s.label, immagine: s.img, isFake: false })));
                        } catch(e) {}
                    }
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${k}.json`), JSON.stringify({ color: sezConf.color, news: allNews }, null, 2));
    }
    scriviLog("🏁 Turno completato.");
}
main();