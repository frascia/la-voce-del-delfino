#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data"); 
const LOG_PATH  = path.join(DATA_DIR, "redazione.log");
const AUTH_PATH = path.join(DATA_DIR, "auth_info.json");
const ACTIVE_CONFIG_PATH = path.join(DATA_DIR, "active_config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Recupero dati dai Secrets di GitHub
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

/**
 * Funzione di Criptazione Semplice (XOR) per offuscare i dati nel JSON
 * Non salva la password, la usa solo per rimescolare i caratteri.
 */
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
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `[TIMESTAMP: ${Date.now()}] ` + prompt }] }],
                systemInstruction: { parts: [{ text: system }] },
                generationConfig: { responseMimeType: "application/json", temperature: parseFloat(temp) }
            })
        });
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) { return null; }
}

async function main() {
    scriviLog(`Avvio Redazione Sicura. Oggi: ${oggi.toUpperCase()}.`);

    const defaultConfig = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), 'utf8'));
    let configPath = path.join(DATA_DIR, `config_${oggi}.json`);
    let activeConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : JSON.parse(JSON.stringify(defaultConfig));

    // Fallback immagini
    if (!activeConfig.site_settings.header_img) activeConfig.site_settings.header_img = defaultConfig.site_settings.header_img;
    if (!activeConfig.site_settings.day_banner) activeConfig.site_settings.day_banner = defaultConfig.site_settings.day_banner;
    
    activeConfig.site_settings.last_update = new Date().toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(activeConfig));
    
    // --- PROTOCOLLO SICUREZZA ---
    // 1. Creiamo un Hash SHA-256 della password (impossibile da invertire)
    const pwdHash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    
    // 2. Criptiamo i messaggi segreti usando la password come chiave
    const encryptedVault = encrypt(secretData, adminPwd);

    // 3. Salviamo nel JSON solo Hash e dati criptati. La password REALE sparisce.
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ 
        check: pwdHash, 
        data: encryptedVault,
        ts: activeConfig.site_settings.last_update
    }));

    // --- GENERAZIONE NEWS ---
    const SYSTEM_PROMPT = `Sei un redattore satirico. Genera JSON: {"titolo": "...", "articolo": "...", "commento": "...", "fonte": "..."}. Mood: {MOOD}.`;

    for (const k of Object.keys(activeConfig)) {
        if (["site_settings", "satira_config"].includes(k)) continue;
        let allNews = [];
        const sezConf = activeConfig[k];
        for (const [query, s] of Object.entries(sezConf)) {
            if (query === "color" || s.count <= 0) continue;
            
            if (s.label === "Satira") {
                const temi = activeConfig.satira_config.temi;
                for (let i = 0; i < s.count; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(SYSTEM_PROMPT.replace('{MOOD}', s.mood), `INVENTA notizia falsa su: ${tema}`, s.weight);
                    if (raw) { try { allNews.push({ ...JSON.parse(raw), categoria: s.label, immagine: s.img, isFake: true }); } catch { i--; } }
                }
            } else {
                // ... logica RSS omessa per brevità, resta uguale a prima ...
            }
        }
        fs.writeFileSync(path.join(DATA_DIR, `news-${k}.json`), JSON.stringify({ color: sezConf.color, news: allNews }));
    }
    scriviLog("Fine turno. Dati sensibili bruciati.");
}
main();