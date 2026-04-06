#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../public/data");
const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino-secret";
const secretData = process.env.ADMIN_SECRET_DATA || "Nessun dato riservato.";

const log = (msg) => {
    const timestamp = new Date().toLocaleString('it-IT');
    fs.appendFileSync(LOG_PATH, `[${timestamp}] ${msg}\n`);
    console.log(`> ${msg}`);
};

async function callGemini(system, prompt) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    for (let i = 0; i < 5; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: system }] },
                    generationConfig: { responseMimeType: "application/json", temperature: 0.8 }
                })
            });
            const data = await res.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        } catch (e) {
            await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        }
    }
    return null;
}

async function fetchRSS(query, count) {
    if (count <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        const xml = await res.text();
        const titles = [];
        const regex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        let match;
        while ((match = regex.exec(xml)) !== null && titles.length < count) {
            titles.push(match[1]);
        }
        return titles;
    } catch { return []; }
}

async function run() {
    log("⚓️ Apertura redazione...");
    
    if (!fs.existsSync(CONFIG_PATH)) {
        log("ERRORE: config.json non trovato in public/data/");
        return;
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const updateTime = new Date().toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    
    config.site_settings.last_update = updateTime;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(config, null, 2));

    const pwdHash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = btoa(secretData); // Semplice offuscamento
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: pwdHash, data: encrypted, ts: updateTime }));

    const SYSTEM_PROMPT = `Sei un redattore satirico pescarese. Genera JSON: {"titolo": "...", "articolo": "...", "commento": "...", "fonte": "..."}.`;

    for (const key of Object.keys(config)) {
        if (["site_settings", "satira_config"].includes(key)) continue;
        
        let sectionNews = [];
        const categories = config[key];

        for (const [catName, settings] of Object.entries(categories)) {
            if (catName === "color" || settings.count <= 0) continue;

            log(`Pescando news per: ${catName}`);
            
            if (settings.label === "Satira") {
                const temi = config.satira_config.temi;
                for (let i = 0; i < settings.count; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(SYSTEM_PROMPT, `Inventa notizia assurda su: ${tema}`);
                    if (raw) {
                        try {
                            const p = JSON.parse(raw.replace(/```json\n?|```/g, ""));
                            sectionNews.push({ ...p, categoria: settings.label, immagine: settings.img });
                        } catch(e) {}
                    }
                }
            } else {
                const titles = await fetchRSS(catName, settings.count);
                if (titles.length > 0) {
                    const raw = await callGemini(SYSTEM_PROMPT, `Scrivi un articolo satirico basato su:\n${titles.join('\n')}`);
                    if (raw) {
                        try {
                            const p = JSON.parse(raw.replace(/```json\n?|```/g, ""));
                            const items = Array.isArray(p) ? p : [p];
                            sectionNews.push(...items.map(n => ({ ...n, categoria: settings.label, immagine: settings.img })));
                        } catch(e) {}
                    }
                }
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${key}.json`), JSON.stringify({ color: categories.color, news: sectionNews }, null, 2));
    }
    log("🏁 Redazione chiusa. Notizie in banchina.");
}

run();