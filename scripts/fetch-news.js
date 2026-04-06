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
        scriviLog(`[ATTENZIONE] Ricerca modelli fallita. Uso ${activeGeminiModel}`);
    }
}

/**
 * Pesca i titoli reali con maggiore tolleranza
 */
async function fetchRSS(query, max) {
    if (max <= 0) return [];
    // Rimuoviamo il filtro restrittivo when:2d per vedere se Google ci dà più roba
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        const titles = [];
        
        // Limite di 3 giorni invece di 2, per sicurezza
        const limiteTempo = Date.now() - (3 * 24 * 60 * 60 * 1000);
        
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let match;
        while ((match = itemRegex.exec(xml)) !== null && titles.length < max) {
            const itemContent = match[1];
            
            // Controllo Data
            const dMatch = itemContent.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (dMatch) {
                const d = new Date(dMatch[1]).getTime();
                if (!isNaN(d) && d < limiteTempo) continue; 
            }
            
            const tMatch = itemContent.match(/<title>(.*?)<\/title>/i);
            if (tMatch) {
                let t = tMatch[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").split(" - ")[0].trim();
                if (!titles.includes(t)) titles.push(t);
            }
        }
        return titles;
    } catch (e) {
        scriviLog(`Errore nel fetch RSS per ${query}: ${e.message}`);
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
                    }
                })
            });
            const d = await res.json();
            if (d.candidates && d.candidates[0].content) {
                return d.candidates[0].content.parts[0].text;
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

async function main() {
    scriviLog("⚓️ Inizio turno di redazione (Fetch-News)...");
    await trovaUltimoModello();
    scriviLog(`🤖 Modello in uso: ${activeGeminiModel}`);
    
    const fusoItalia = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const dataOggiItalia = new Date(fusoItalia);
    const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const oggi = giorni[dataOggiItalia.getDay()];
    
    let currentConfigPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(currentConfigPath)) currentConfigPath = CONFIG_PATH;
    const CONFIG = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));
    
    const oraAggiornamento = new Date().toLocaleString('it-IT', { 
        timeZone: 'Europe/Rome', 
        hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' 
    });
    
    CONFIG.site_settings.last_update = oraAggiornamento;
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));

    const hash = crypto.createHash('sha256').update(adminPwd).digest('hex');
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ check: hash, data: Buffer.from(secretData).toString('base64'), ts: oraAggiornamento }));

    const sysPromptSatira = "Sei un giornalista satirico pescarese. Restituisci JSON con chiavi 'titolo', 'articolo', 'commento'. Articolo lungo (800+ car.), ironico e assurdo.";
    const sysPromptVera = "Sei un giornalista serio. Restituisci JSON con chiavi 'titolo', 'articolo', 'commento'. Articolo VERO, lungo (800+ car.), professionale.";

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;
        
        let newsSezione = [];
        const categorie = CONFIG[sez];
        let quotaAvanzata = 0;

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;
            
            const target = info.count + quotaAvanzata;
            quotaAvanzata = 0;
            
            scriviLog(`🔍 Cerco notizie per: ${nome} (Target: ${target})`);
            
            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Delfino"];
                for (let i = 0; i < target; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const r = await callGemini(sysPromptSatira, `Inventa una notizia assurda su: ${tema}`);
                    if (r) newsSezione.push({ ...JSON.parse(r), categoria: info.label, immagine: info.img, is_satira: true });
                }
            } else {
                const titoli = await fetchRSS(nome, target);
                scriviLog(`📈 Trovati ${titoli.length} titoli per ${nome}`);
                
                if (titoli.length < target) quotaAvanzata = target - titoli.length;
                
                // Se non troviamo proprio nulla, facciamo un articolo di "riempimento" intelligente
                if (titoli.length === 0) {
                    scriviLog(`⚠️ Vuoto totale per ${nome}, genero articolo di riempimento.`);
                    const r = await callGemini(sysPromptVera, `Scrivi un editoriale serio sulla situazione attuale di ${nome} anche se non ci sono news fresche dell'ultima ora.`);
                    if (r) newsSezione.push({ ...JSON.parse(r), categoria: info.label, immagine: info.img });
                } else {
                    for (const t of titoli) {
                        const r = await callGemini(sysPromptVera, `Scrivi un articolo dettagliato su: ${t}`);
                        if (r) newsSezione.push({ ...JSON.parse(r), categoria: info.label, immagine: info.img });
                    }
                }
            }
        }
        
        const outPath = path.join(DATA_DIR, `news-${sez}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ color: categorie.color, news: newsSezione }, null, 2));
        scriviLog(`✅ Sezione ${sez} completata con ${newsSezione.length} articoli.`);
    }
    scriviLog("🏁 Turno completato con successo.");
}

main().catch(err => scriviLog(`❌ ERRORE CRITICO: ${err.message}`));