#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Percorsi relativi partendo da scripts/ verso public/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

// Assicuriamoci che la cartella public/data esista
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const apiKey = process.env.GEMINI_API_KEY || "";
const adminPwd = process.env.ADMIN_PASSWORD || "delfino2026";
const secretData = process.env.ADMIN_SECRET_DATA || "Segreto di Pescara.";

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT');
    const riga = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

async function callGemini(sys, prompt) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
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
        } catch (e) {
            await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        }
    }
    return null;
}

async function main() {
    scriviLog("⚓️ Inizio turno di pesca (Fetch)...");
    
    if (!fs.existsSync(CONFIG_PATH)) {
        scriviLog(`ERRORE: ${CONFIG_PATH} non trovato!`);
        return;
    }

    const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const oraAggiornamento = new Date().toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    
    CONFIG.site_settings.last_update = oraAggiornamento;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    const encrypted = Buffer.from(secretData).toString('base64'); 
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: encrypted, ts: oraAggiornamento }));

    const sysPrompt = "Sei un giornalista satirico pescarese. Rispondi SOLO in JSON: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}";

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        
        let newsSezione = [];
        const categorie = CONFIG[sez];

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;

            scriviLog(`Lancio le reti per: ${nome}`);
            const prompt = info.label === "Satira" ? `Inventa una notizia assurda su: ${nome}` : `Satira su queste news: ${nome}`;
            
            for (let i = 0; i < info.count; i++) {
                const raw = await callGemini(sysPrompt, `${prompt} [Var: ${i}]`);
                if (raw) {
                    try {
                        const parsed = JSON.parse(raw.replace(/```json\n?|```/g, ""));
                        newsSezione.push({ ...parsed, categoria: info.label, immagine: info.img });
                    } catch(e) { scriviLog(`Errore JSON per ${nome}`); }
                }
            }
        }
        
        const outPath = path.join(DATA_DIR, `news-${sez}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
    }
    
    scriviLog("🏁 Turno completato. Dati scritti in public/data.");
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
