#!/usr/bin/env node
/**
 * 1-fetch-v3.js
 * FASE 1 — Nuova architettura v2
 * Supporto Gemini/Groq con fallback persistente, modello Groq dinamico,
 * GNews API + fallback RSS, gestione sicura draft.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR   = path.join(__dirname, "..");
const DATA_DIR   = path.join(BASE_DIR, "public", "data");

const LOG_PATH        = path.join(DATA_DIR, "redazione-v2.log");
const CONFIG_PATH     = path.join(DATA_DIR, "config_v2.json");
const DRAFT_PATH      = path.join(DATA_DIR, "_draft-v2.json");
const RELAZIONI_PATH  = path.join(DATA_DIR, "_relazioni.json");
const PERSONAGGI_PATH = path.join(DATA_DIR, "_personaggi.json");
const CHAT_PATH       = path.join(DATA_DIR, "_chat.json");
const CONTATORI_PATH  = path.join(DATA_DIR, "_contatori.json");
const PROVIDER_STATE_PATH = path.join(DATA_DIR, "_provider_state.json");
const TEMP_PATH       = DRAFT_PATH + ".tmp";
const BACKUP_PATH     = DRAFT_PATH + ".bak";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// UTILITÀ LOG
// ---------------------------------------------------------------------------

function scriviLog(msg) {
    const ts = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    const riga = `[${ts}] [1-fetch-v2] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

// ---------------------------------------------------------------------------
// CARICA / SALVA JSON
// ---------------------------------------------------------------------------

function caricaJSON(filePath, defaultVal) {
    try {
        if (fs.existsSync(filePath))
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        scriviLog(`[WARN] Impossibile leggere ${filePath}: ${e.message}`);
    }
    return defaultVal;
}

function salvaJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// UTILITY SICURE DRAFT
// ---------------------------------------------------------------------------

function contaArticoli(draft) {
    return Object.values(draft.sezioni || {})
        .reduce((acc, s) => acc + (s.articoli?.length || 0), 0);
}

function safeWriteDraft(draft) {
    const totale = contaArticoli(draft);
    if (totale === 0) {
        scriviLog("⚠️ Draft vuoto → NON sovrascrivo.");
        return false;
    }
    try {
        salvaJSON(TEMP_PATH, draft);
        if (fs.existsSync(DRAFT_PATH)) fs.copyFileSync(DRAFT_PATH, BACKUP_PATH);
        fs.renameSync(TEMP_PATH, DRAFT_PATH);
        if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
        scriviLog(`💾 Draft salvato in modo sicuro (${totale} articoli).`);
        return true;
    } catch (e) {
        scriviLog(`❌ Errore scrittura draft: ${e.message}`);
        if (fs.existsSync(BACKUP_PATH)) {
            fs.copyFileSync(BACKUP_PATH, DRAFT_PATH);
            scriviLog("♻️ Ripristinato backup.");
        }
        return false;
    }
}

// ---------------------------------------------------------------------------
// RECOVERY AUTOMATICO POST-CRASH
// ---------------------------------------------------------------------------

if (fs.existsSync(TEMP_PATH)) {
    scriviLog("♻️ TEMP trovato → possibile crash precedente.");
    try {
        const temp = caricaJSON(TEMP_PATH, null);
        if (temp && contaArticoli(temp) > 0) {
            fs.renameSync(TEMP_PATH, DRAFT_PATH);
            scriviLog("✅ Draft recuperato da TEMP.");
        } else {
            fs.unlinkSync(TEMP_PATH);
            scriviLog("🧹 TEMP corrotto eliminato.");
        }
    } catch (e) {
        scriviLog(`⚠️ Errore recovery TEMP: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// PULIZIA LOG (ogni 48 ore)
// ---------------------------------------------------------------------------

if (fs.existsSync(LOG_PATH)) {
    const primaRiga = fs.readFileSync(LOG_PATH, "utf8").split("\n")[0];
    const m = primaRiga.match(/\[(\d{2}\/\d{2}\/\d{4})/);
    if (m) {
        const [g, me, a] = m[1].split("/");
        const dataLog = new Date(`${a}-${me}-${g}`);
        if ((Date.now() - dataLog.getTime()) / 3600000 >= 48) {
            fs.unlinkSync(LOG_PATH);
        }
    }
}

// ---------------------------------------------------------------------------
// STATO GLOBALE
// ---------------------------------------------------------------------------

const apiKey = process.env.GEMINI_API_KEY || "";
const groqApiKey = process.env.GROQ_API_KEY || "";
let groqModelCorrente = process.env.GROQ_MODEL || "llama3-70b-8192";
let groqMaxTokens = 1024; // verrà impostato dinamicamente
let ricercaModelloGroqEffettuata = false;

const gnewsApiKey = process.env.GNEWS_API_KEY || "";
const newsSource = process.env.NEWS_SOURCE || "gnews";
let activeGeminiModel = "gemini-1.5-flash";
let quotaGiornalieraEsaurita = false;
let contatoreChiamateApi = 0;

const MAX_FAILURES_BEFORE_SWITCH = 2;
let providerState = { provider: "gemini", failureCount: 0 };
let currentProvider = "gemini";
let failureCount = 0;

function caricaStatoProvider() {
    try {
        if (fs.existsSync(PROVIDER_STATE_PATH)) {
            const data = JSON.parse(fs.readFileSync(PROVIDER_STATE_PATH, "utf8"));
            if (data.provider === "gemini" || data.provider === "groq") {
                return data;
            }
        }
    } catch (e) {
        scriviLog(`[WARN] Impossibile leggere stato provider: ${e.message}`);
    }
    return { provider: "gemini", failureCount: 0 };
}

function salvaStatoProvider(state) {
    try {
        fs.writeFileSync(PROVIDER_STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
        scriviLog(`[WARN] Impossibile salvare stato provider: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// DECAY SETTIMANALE RELAZIONI
// ---------------------------------------------------------------------------

function applicaDecay(relazioni) {
    const DECAY_OGNI_N_RUN = 14;
    const DECAY_AMOUNT = 0.1;
    relazioni._runCount = (relazioni._runCount || 0) + 1;
    if (relazioni._runCount >= DECAY_OGNI_N_RUN) {
        relazioni._runCount = 0;
        for (const chiave of Object.keys(relazioni)) {
            if (chiave.startsWith("_")) continue;
            const r = relazioni[chiave];
            if (typeof r.score === "number") {
                r.score = parseFloat((r.score * (1 - DECAY_AMOUNT)).toFixed(3));
                r.label = labelDaScore(r.score);
            }
        }
        scriviLog("📉 Decay settimanale relazioni applicato.");
    }
    return relazioni;
}

function labelDaScore(score) {
    if (score >= 0.7)  return "amico";
    if (score >= 0.3)  return "simpatico";
    if (score >= -0.2) return "neutro";
    if (score >= -0.6) return "diffidente";
    return "ostile";
}

// ---------------------------------------------------------------------------
// RICERCA MODELLO GEMINI PIÙ RECENTE
// ---------------------------------------------------------------------------

async function trovaUltimoModello() {
    if (!apiKey) return;
    try {
        const res  = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        if (data.models) {
            const validi = data.models
                .filter(m => m.name.includes("gemini") &&
                             m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            const flash = validi.filter(m => m.includes("flash")).sort((a, b) => b.localeCompare(a));
            if (flash.length > 0) activeGeminiModel = flash[0];
            else if (validi.length > 0) activeGeminiModel = validi.sort((a, b) => b.localeCompare(a))[0];
            scriviLog(`[MODELLO] Gemini: ${activeGeminiModel}`);
        }
    } catch (e) {
        scriviLog(`[WARN] Ricerca modello Gemini fallita: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// RICERCA MODELLO GROQ PIÙ RECENTE (con max_tokens dinamico)
// ---------------------------------------------------------------------------

async function trovaUltimoModelloGroq() {
    if (!groqApiKey) {
        scriviLog("ERRORE: GROQ_API_KEY mancante per lista modelli");
        return;
    }
    const url = "https://api.groq.com/openai/v1/models";
    const headers = { "Authorization": `Bearer ${groqApiKey}` };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            scriviLog(`[GROQ ERRORE] Lista modelli: ${response.status}`);
            return;
        }
        const data = await response.json();
        if (!data.data) return;
        // Filtra modelli testuali
        const testuali = data.data.filter(m =>
            m.id && (m.id.includes("llama") || m.id.includes("mixtral") || m.id.includes("gemma")) &&
            !m.id.includes("embed")
        );
        if (testuali.length === 0) return;
        // Dai priorità ai modelli llama
        const migliori = testuali.filter(m => m.id.includes("llama"));
        const daOrdinare = migliori.length > 0 ? migliori : testuali;
        daOrdinare.sort((a,b) => (b.created || 0) - (a.created || 0));
        const migliore = daOrdinare[0].id;
        if (migliore !== groqModelCorrente) {
            scriviLog(`[GROQ] Modello aggiornato: ${migliore} (era ${groqModelCorrente})`);
            groqModelCorrente = migliore;
        } else {
            scriviLog(`[GROQ] Modello già ottimale: ${groqModelCorrente}`);
        }
        
        // Imposta groqMaxTokens in base al modello selezionato
        if (groqModelCorrente.includes("gemma")) {
            groqMaxTokens = 512;   // Gemma ha output limitato a 512
        } else if (groqModelCorrente.includes("llama3-70b")) {
            groqMaxTokens = 2000;  // Supporta fino a 4096
        } else if (groqModelCorrente.includes("llama3-8b")) {
            groqMaxTokens = 1024;  // Limite prudente
        } else if (groqModelCorrente.includes("mixtral")) {
            groqMaxTokens = 2000;
        } else {
            groqMaxTokens = 1024;  // Default
        }
        scriviLog(`[GROQ] max_tokens impostato a ${groqMaxTokens} per il modello ${groqModelCorrente}`);
    } catch (e) {
        scriviLog(`[GROQ] Errore lista modelli: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// FETCH NOTIZIE: GNews + fallback RSS
// ---------------------------------------------------------------------------

async function fetchGNews(query, max) {
    if (!gnewsApiKey) return [];
    if (max <= 0) return [];
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=it&country=it&max=${max}&token=${gnewsApiKey}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || data.errors) {
            scriviLog(`[GNews ERR] Status ${res.status}, errors: ${JSON.stringify(data.errors)}`);
            return [];
        }
        if (!data.articles || !Array.isArray(data.articles)) {
            scriviLog(`[GNews] Formato inaspettato: manca articles[]`);
            return [];
        }
        const titles = data.articles.map(art => art.title);
        scriviLog(`[GNews] ${titles.length} titoli per "${query}"`);
        return titles;
    } catch (e) {
        scriviLog(`[GNews] Eccezione: ${e.message}`);
        return [];
    }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        const titles = [];
        const dueGiorniFa = Date.now() - 2 * 24 * 3600000;
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && titles.length < max) {
            const item = m[1];
            const pd = item.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (pd && new Date(pd[1]).getTime() < dueGiorniFa) continue;
            const tl = item.match(/<title>(.*?)<\/title>/i);
            if (tl) {
                let t = tl[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").split(" - ")[0].trim();
                if (!titles.includes(t)) titles.push(t);
            }
        }
        return titles;
    } catch (e) {
        scriviLog(`RSS errore per "${query}": ${e.message}`);
        return [];
    }
}

async function fetchNotizie(query, max) {
    if (newsSource === "gnews") {
        const titoli = await fetchGNews(query, max);
        if (titoli.length > 0) return titoli;
        scriviLog(`⚠️ GNews fallito, fallback RSS`);
        return await fetchRSS(query, max);
    }
    return await fetchRSS(query, max);
}

// ---------------------------------------------------------------------------
// PAUSA E GESTIONE QUOTA
// ---------------------------------------------------------------------------

const ATTESA_GEMINI_MS = 1500;
async function pausaGemini() {
    await new Promise(r => setTimeout(r, ATTESA_GEMINI_MS));
}

async function gestisciErroreQuota(msg) {
    const m = msg.match(/Please retry in ([\d.]+)s/);
    const sec = m ? parseFloat(m[1]) + 2 : 30;
    scriviLog(`⏳ Attendo ${sec.toFixed(1)}s per quota...`);
    await new Promise(r => setTimeout(r, sec * 1000));
}

// ---------------------------------------------------------------------------
// CHIAMATA GEMINI
// ---------------------------------------------------------------------------

async function callGemini(sys, prompt, temperature = 0.85) {
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKey}`;
    for (let i = 0; i < 3; i++) {
        await pausaGemini();
        try {
            contatoreChiamateApi++;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });
            const d = await res.json();
            if (d.error) {
                scriviLog(`[ERRORE GEMINI] ${d.error.message} (code: ${d.error.code})`);
                const code = d.error.code;
                const msg = (d.error.message || "").toLowerCase();
                if (msg.includes("limit") && msg.includes("per day")) {
                    scriviLog("❌ QUOTA GIORNALIERA GEMINI");
                    return null;
                }
                if (code === 429 || code === 503) {
                    if (msg.includes("quota exceeded")) {
                        await gestisciErroreQuota(d.error.message);
                        continue;
                    }
                    const ms = Math.pow(2, i) * 10000;
                    scriviLog(`⏳ Errore ${code}, attendo ${ms/1000}s...`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                return null;
            }
            if (d.candidates?.length > 0) {
                return d.candidates[0].content.parts[0].text;
            }
            return null;
        } catch (e) {
            scriviLog(`[ERRORE RETE GEMINI] ${e.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// CHIAMATA GROQ (con max_tokens dinamico e riduzione automatica)
// ---------------------------------------------------------------------------

async function callGroq(sys, prompt, temperature = 0.85) {
    if (!groqApiKey) return null;
    if (!ricercaModelloGroqEffettuata) {
        await trovaUltimoModelloGroq();
        ricercaModelloGroqEffettuata = true;
    }

    // Troncamento input per evitare errori di lunghezza
    const MAX_SYS = 4000;
    const MAX_PROMPT = 15000;
    let finalSys = sys.length > MAX_SYS ? sys.substring(0, MAX_SYS) + "... [troncato]" : sys;
    let finalPrompt = prompt.length > MAX_PROMPT ? prompt.substring(0, MAX_PROMPT) + "... [troncato]" : prompt;

    const messages = [
        { role: "system", content: finalSys },
        { role: "user", content: finalPrompt }
    ];

    let currentMaxTokens = groqMaxTokens; // copia locale per eventuali riduzioni temporanee
    const url = "https://api.groq.com/openai/v1/chat/completions";
    for (let i = 0; i < 3; i++) {
        await pausaGemini();
        try {
            contatoreChiamateApi++;
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${groqApiKey}`
                },
                body: JSON.stringify({
                    model: groqModelCorrente,
                    messages: messages,
                    temperature: temperature,
                    max_tokens: currentMaxTokens,
                    response_format: { type: "json_object" }
                })
            });
            const d = await res.json();
            if (!res.ok || d.error) {
                const errorMsg = d.error?.message || `HTTP ${res.status}`;
                const code = d.error?.code || res.status;
                scriviLog(`[ERRORE GROQ] ${errorMsg} (code: ${code})`);
                const msg = (errorMsg || "").toLowerCase();
                if (msg.includes("limit") || code === 429) {
                    scriviLog("❌ QUOTA GROQ ESAURITA");
                    return null;
                }
                // Gestione specifica per max_tokens troppo alto
                if (code === 400 && (msg.includes("max_tokens") || msg.includes("context_window"))) {
                    if (currentMaxTokens > 128) {
                        currentMaxTokens = Math.max(128, Math.floor(currentMaxTokens * 0.6));
                        scriviLog(`[GROQ] Riduzione max_tokens a ${currentMaxTokens} e riprovo...`);
                        continue;
                    } else {
                        scriviLog(`[GROQ] max_tokens già minimo (${currentMaxTokens}), impossibile ridurre ulteriormente.`);
                        return null;
                    }
                }
                if (code === 400 && msg.includes("reduce the length")) {
                    finalPrompt = finalPrompt.substring(0, Math.floor(finalPrompt.length * 0.6)) + "... [troncato 2]";
                    messages[1].content = finalPrompt;
                    scriviLog(`[GROQ] Nuovo tentativo con prompt ridotto (${finalPrompt.length} char)`);
                    continue;
                }
                if (code === 429 || code === 503 || code === 500) {
                    const ms = Math.pow(2, i) * 10000;
                    scriviLog(`⏳ Errore ${code}, attendo ${ms/1000}s...`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                return null;
            }
            const content = d.choices?.[0]?.message?.content;
            if (!content) return null;
            let jsonText = content.trim().replace(/^```json\s*/, "").replace(/```$/, "");
            JSON.parse(jsonText);
            return jsonText;
        } catch (e) {
            scriviLog(`[ERRORE RETE GROQ] ${e.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// FUNZIONE UNIFICATA CON FALLBACK PERSISTENTE
// ---------------------------------------------------------------------------

function isFallbackErrore(jsonString) {
    if (!jsonString) return true;
    try {
        const obj = JSON.parse(jsonString);
        const testo = (obj.articolo || "").toLowerCase();
        return testo.includes("contenuto non generato") || testo.includes("limite");
    } catch (e) { return true; }
}

function generaFallback(prompt) {
    return JSON.stringify({
        titolo: (prompt || "").substring(0, 60),
        articolo: "Contenuto non generato per problemi temporanei del provider LLM.",
        commento: ""
    });
}

async function callLLM(sys, prompt, temperature = 0.85) {
    async function tentaProvider(provider) {
        return provider === "groq" ? await callGroq(sys, prompt, temperature) : await callGemini(sys, prompt, temperature);
    }
    let result = await tentaProvider(currentProvider);
    if (result && !isFallbackErrore(result)) {
        failureCount = 0;
        if (providerState.provider !== currentProvider) {
            providerState.provider = currentProvider;
            salvaStatoProvider(providerState);
        }
        return result;
    }
    failureCount++;
    scriviLog(`⚠️ Fallimento ${currentProvider} (${failureCount}/${MAX_FAILURES_BEFORE_SWITCH})`);
    if (failureCount >= MAX_FAILURES_BEFORE_SWITCH) {
        const old = currentProvider;
        currentProvider = currentProvider === "gemini" ? "groq" : "gemini";
        scriviLog(`🔄 Cambio provider: ${old} → ${currentProvider}`);
        failureCount = 0;
        providerState.provider = currentProvider;
        salvaStatoProvider(providerState);
        const newResult = await tentaProvider(currentProvider);
        if (newResult && !isFallbackErrore(newResult)) return newResult;
        scriviLog(`❌ Anche ${currentProvider} fallisce.`);
        return generaFallback(prompt);
    }
    return generaFallback(prompt);
}

// ---------------------------------------------------------------------------
// UTILITIES CALENDARIO E PERSONAGGI
// ---------------------------------------------------------------------------

function giornoOggi() {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
    return ["dom","lun","mar","mer","gio","ven","sab"][d.getDay()];
}

function risolviAgenda(AGENDA, oggi) {
    for (const [k, v] of Object.entries(AGENDA)) {
        if (k === "default") continue;
        if (k.split(",").map(s=>s.trim()).includes(oggi)) return { ...AGENDA.default, ...v };
    }
    return AGENDA.default;
}

function risolviPersonaggio(CHI, nome) {
    return CHI[nome] || CHI["default"] || { mood: "neutro", peso: 0.5, avatar: "🐬", img: "default_personaggio.webp" };
}

// ---------------------------------------------------------------------------
// GENERA ARTICOLO
// ---------------------------------------------------------------------------

async function generaArticolo(voce, CHI, titolo) {
    const firma = risolviPersonaggio(CHI, voce.firma);
    const moodFirma = firma.mood || "neutro";
    const bioFirma = (firma.bio_breve || firma.bio) ? `La tua storia: "${firma.bio_breve || firma.bio}".` : "";
    const moodCommento = voce.mood ? `Il tono del commento finale deve essere: ${voce.mood}` : "";
    const isGenerato = voce.tipo === "GEN";
    const puoInventare = voce.fantasia === true;
    const sys = `Sei ${voce.firma}, giornalista con carattere: "${moodFirma}". ${bioFirma}
Rispondi con JSON: {"titolo":"...","articolo":"...","commento":"..."}.
Articolo di ~${voce._parole || 400} parole.
${puoInventare ? "Puoi inventare liberamente." : "Scrivi cose reali, senza inventare fatti falsi."}
Nessun riferimento temporale specifico (oggi, ieri, ecc.).
${moodCommento}`;
    const userPrompt = isGenerato ? `Scrivi un articolo su: ${titolo}` : `Notizia reale: ${titolo}. Scrivi un articolo.`;
    return await callLLM(sys, userPrompt, voce.weight_articolo ?? 0.8);
}

// ---------------------------------------------------------------------------
// GENERA COMMENTI
// ---------------------------------------------------------------------------

async function generaCommenti(voce, CHI, relazioni, personaggi, articolo, commentiPrecedenti, LIMITI = {}) {
    if (quotaGiornalieraEsaurita) return null;
    const nomi = Object.keys(CHI).filter(n => n !== "default");
    const contestoRelazioni = nomi.flatMap(a => nomi.filter(b=>b!==a).map(b=>{
        const r = relazioni[`${a}→${b}`];
        return r ? `${a} è ${r.label} verso ${b} (score: ${r.score})` : null;
    }).filter(Boolean)).join(". ");
    const contestoStati = nomi.map(n=>{
        const p = personaggi[n];
        return p?.stato && p.stato!=="normale" ? `${n} è: ${p.stato} (umore: ${p.umore||"neutro"})` : null;
    }).filter(Boolean).join(". ");
    const contestoCommenti = commentiPrecedenti?.length ? `Commenti precedenti:\n${commentiPrecedenti.map(c=>`${c.nome} (${c.avatar}): "${c.testo}"`).join("\n")}` : "";
    const sys = `Sei il moderatore. Personaggi: ${nomi.map(n=>`${n} (${CHI[n].avatar}, mood: "${CHI[n].mood}")`).join(", ")}.
Relazioni: ${contestoRelazioni || "nessuna"}.
Stati: ${contestoStati || "normali"}.
${contestoCommenti}
Scegli da ${LIMITI.commenti_min??1} a ${LIMITI.commenti_max??3} personaggi che commentano notizia e commenti precedenti.
Il personaggio "${voce.firma}" non può commentare se stesso.
Rispondi solo JSON: {"commenti":[{"nome":"...","avatar":"...","testo":"..."}]}`;
    const userPrompt = `Articolo: "${articolo}"\nGenera commenti.`;
    return await callLLM(sys, userPrompt, voce.weight_commento ?? 0.7);
}

// ---------------------------------------------------------------------------
// AGGIORNA RELAZIONI
// ---------------------------------------------------------------------------

async function aggiornaRelazioni(CHI, relazioni, personaggi, articolo, commenti) {
    if (!commenti?.length) return;
    const sys = `Analista dinamiche sociali. Restituisci JSON: {"delta_relazioni":[{"da":"...","a":"...","delta":0.1}],"nuovi_stati":[{"nome":"...","stato":"...","umore":"..."}]}
Delta da -0.3 a +0.3.`;
    const userPrompt = `Articolo: "${articolo.substring(0,300)}..."\nCommenti:\n${commenti.map(c=>`${c.nome}: "${c.testo}"`).join("\n")}`;
    const raw = await callLLM(sys, userPrompt);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}")+1));
        for (const d of (parsed.delta_relazioni || [])) {
            const key = `${d.da}→${d.a}`;
            if (!relazioni[key]) relazioni[key] = { score:0, label:"neutro", ultimo_aggiornamento:"" };
            let newScore = Math.max(-1, Math.min(1, (relazioni[key].score||0) + d.delta));
            relazioni[key].score = Math.round(newScore * 1000)/1000;
            relazioni[key].label = labelDaScore(relazioni[key].score);
            relazioni[key].ultimo_aggiornamento = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome"});
        }
        for (const s of (parsed.nuovi_stati || [])) {
            if (!personaggi[s.nome]) personaggi[s.nome] = {};
            personaggi[s.nome].stato = s.stato;
            personaggi[s.nome].umore = s.umore;
            personaggi[s.nome].dal = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome"});
        }
        scriviLog(`🔄 Relazioni: ${parsed.delta_relazioni?.length || 0} delta, ${parsed.nuovi_stati?.length || 0} stati.`);
    } catch(e) { scriviLog(`[WARN] Parse relazioni: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// PARSE JSON
// ---------------------------------------------------------------------------

function parseJSON(raw) {
    if (!raw) return null;
    try {
        let start = raw.indexOf("{"), end = raw.lastIndexOf("}");
        if (start !== -1 && end !== -1) return JSON.parse(raw.substring(start, end+1));
        start = raw.indexOf("["); end = raw.lastIndexOf("]");
        if (start !== -1 && end !== -1) {
            const arr = JSON.parse(raw.substring(start, end+1));
            return arr[0] || null;
        }
    } catch(e) {}
    return null;
}

// ---------------------------------------------------------------------------
// GENERA CHAT
// ---------------------------------------------------------------------------

async function generaChat(CHI, relazioni, personaggi) {
    if (quotaGiornalieraEsaurita) return null;
    const nomi = Object.keys(CHI).filter(n=>n!=="default");
    if (nomi.length<2) return null;
    const contestoRelazioni = nomi.flatMap(a=>nomi.filter(b=>b!==a).map(b=>{
        const r = relazioni[`${a}→${b}`];
        return r ? `${a} è ${r.label} verso ${b}` : null;
    }).filter(Boolean)).join(". ");
    const contestoStati = nomi.map(n=>{
        const p = personaggi[n];
        return p?.stato && p.stato!=="normale" ? `${n}: ${p.stato} (umore: ${p.umore||"neutro"})` : null;
    }).filter(Boolean).join(". ");
    const spunti = ["lamentele sul caffè","battibecco su un articolo","elogi ironici","discussione sul carico di lavoro","annuncio pausa"];
    const spunto = spunti[Math.floor(Math.random()*spunti.length)];
    const sys = `Narratore chat redazione. Personaggi: ${nomi.map(n=>`${n} (${CHI[n].avatar}, carattere: "${CHI[n].mood}")`).join(", ")}.
Relazioni: ${contestoRelazioni||"nessuna"}. Stati: ${contestoStati||"normali"}.
Spunto: ${spunto}. Genera chat 4-8 messaggi tra 2-3 personaggi.
Rispondi JSON: {"chat":[{"nome":"...","avatar":"...","testo":"..."}]}`;
    const raw = await callLLM(sys, "Genera chat.");
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}")+1));
        return parsed.chat || null;
    } catch(e) { return null; }
}

// ---------------------------------------------------------------------------
// CONTATORI GIORNALIERI
// ---------------------------------------------------------------------------

function caricaContatori(LIMITI) {
    const oraRoma = new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Rome"}));
    const oggi = oraRoma.toLocaleDateString("it-IT",{day:"2-digit",month:"2-digit"});
    const ora = oraRoma.getHours(), min = oraRoma.getMinutes();
    const contatori = caricaJSON(CONTATORI_PATH, {});
    const fasciaReset = parseInt(LIMITI.fascia_reset_quote ?? "05");
    const tolleranza = LIMITI.tolleranza_minuti ?? 30;
    const inFasciaReset = Math.abs(ora*60+min - fasciaReset*60) <= tolleranza;
    const deveResettare = contatori.data !== oggi || (inFasciaReset && !contatori.reset_eseguito_oggi);
    if (deveResettare) {
        scriviLog(`🔄 Reset quote (${oggi} ${String(ora).padStart(2,"0")}:${String(min).padStart(2,"0")})`);
        return {
            data: oggi, reset_eseguito_oggi: inFasciaReset, _primoRunOggi: false,
            cerca_modello:0, chat_run:0, chiamate_gemini:0, token_stimati:0, rss_fetch:0, articoli_run:0,
            chiamate_gemini_totali: contatori.chiamate_gemini_totali || 0,
            token_stimati_totali: contatori.token_stimati_totali || 0
        };
    }
    return contatori;
}

function limiteSuperato(contatori, LIMITI, tipo) {
    const limite = LIMITI[tipo];
    if (!limite || limite==="sempre") return false;
    return (contatori[tipo.replace("_max","")] || 0) >= limite;
}

function fasciaDiArticoliAttiva(LIMITI) {
    const fasce = LIMITI.fasce_articoli;
    if (!fasce?.length) return true;
    const oraRoma = new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Rome"}));
    const minuti = oraRoma.getHours()*60 + oraRoma.getMinutes();
    const tolleranza = LIMITI.tolleranza_minuti ?? 30;
    return fasce.some(f => Math.abs(minuti - parseInt(f)*60) <= tolleranza);
}

function paroleTarget(LIMITI) {
    const livello = Math.max(1, Math.min(10, LIMITI.lunghezza_articolo ?? 5));
    return Math.round(80 + (livello-1)*80);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
    const stato = caricaStatoProvider();
    currentProvider = stato.provider;
    failureCount = 0;
    providerState = stato;
    scriviLog(`🔌 Provider iniziale: ${currentProvider}, modello Groq: ${groqModelCorrente}`);
    const oraItalia = new Intl.DateTimeFormat("it-IT",{timeZone:"Europe/Rome", dateStyle:"full", timeStyle:"medium"}).format(new Date());
    scriviLog(`🐬 NUOVO RUN v2 [${oraItalia}]`);
    if (!fs.existsSync(CONFIG_PATH)) { scriviLog(`ERRORE: ${CONFIG_PATH} mancante`); process.exit(1); }
    const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH,"utf8"));
    const { IMPOSTAZIONI, CHI, AGENDA, STILI, REDAZIONE, ICONE } = CONFIG;
    const LIMITI = CONFIG.LIMITI || {};
    const contatori = caricaContatori(LIMITI);
    const articoliAttivi = fasciaDiArticoliAttiva(LIMITI);
    const parole = paroleTarget(LIMITI);
    scriviLog(`📊 Quote: chiamate=${contatori.chiamate_gemini??0}, rss=${contatori.rss_fetch??0}`);
    scriviLog(`🕐 Fascia attiva: ${articoliAttivi?"SÌ":"NO"} | Parole target: ~${parole}`);
    await trovaUltimoModello();
    const oggi = giornoOggi();
    const agenda = risolviAgenda(AGENDA, oggi);
    const oraAggiornamento = new Date().toLocaleString("it-IT",{timeZone:"Europe/Rome", hour:"2-digit", minute:"2-digit", day:"2-digit", month:"2-digit"});
    let relazioni = caricaJSON(RELAZIONI_PATH, { _runCount:0 });
    let personaggi = caricaJSON(PERSONAGGI_PATH, {});
    for (const nome of Object.keys(CHI).filter(n=>n!=="default")) {
        if (!personaggi[nome]) personaggi[nome] = { stato:"normale", umore:"neutro", dal:null };
    }
    relazioni = applicaDecay(relazioni);
    const vociAttive = REDAZIONE.filter(voce => {
        if (voce.g === "default") return true;
        return voce.g.split(",").map(g=>g.trim()).includes(oggi);
    });
    scriviLog(`📋 Voci attive: ${vociAttive.length}`);
    const oggiStr = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome", day:"2-digit", month:"2-digit"});
    let oldDraft = fs.existsSync(DRAFT_PATH) ? caricaJSON(DRAFT_PATH,null) : null;
    const isNuovoGiorno = !oldDraft || oldDraft.dataRiferimento !== oggiStr;
    let draft;
    if (isNuovoGiorno) {
        draft = { dataRiferimento: oggiStr, oraAggiornamento, agenda, impostazioni: IMPOSTAZIONI, stili: STILI, sezioni: {} };
        scriviLog(`🆕 Nuovo draft per ${oggiStr}`);
    } else {
        draft = JSON.parse(JSON.stringify(oldDraft));
        draft.oraAggiornamento = oraAggiornamento;
        scriviLog(`📰 Accumulo su ${contaArticoli(draft)} articoli esistenti`);
    }
    for (const voce of vociAttive) {
        const sez = voce.sez;
        if (!draft.sezioni[sez]) draft.sezioni[sez] = { color: STILI[sez] || STILI["RSS"] || "#005f73", articoli: [] };
    }
    const articoliAbilitati = !limiteSuperato(contatori, LIMITI, "articoli_run_max");
    if (!articoliAbilitati) scriviLog(`⏭️ Limite articoli_run raggiunto`);
    contatori.articoli_run = (contatori.articoli_run||0) + (articoliAbilitati?1:0);
    const codaArticoli = [];
    let articoliGenerati = 0;
    if (articoliAbilitati) {
        for (const voce of vociAttive) {
            const num = voce.num || 1;
            voce._parole = parole;
            scriviLog(`🎣 [${voce.sez}] ${voce.arg} — tipo:${voce.tipo}, num:${num}, firma:${voce.firma}`);
            if (voce.tipo === "GEN") {
                const temi = voce.temi || [voce.arg];
                for (let i=0; i<num; i++) codaArticoli.push({ voce, tema: temi[Math.floor(Math.random()*temi.length)] });
            } else {
                const titoli = await fetchNotizie(voce.arg, num);
                contatori.rss_fetch = (contatori.rss_fetch||0)+1;
                for (const t of titoli) codaArticoli.push({ voce, tema: t });
                if (titoli.length < num) {
                    const mancanti = num - titoli.length;
                    scriviLog(`[CASCATA] Solo ${titoli.length}/${num}, aggiungo ${mancanti} generici`);
                    for (let i=0; i<mancanti; i++) codaArticoli.push({ voce, tema: `[Generico] ${voce.arg} - approfondimento` });
                }
            }
        }
    }
    for (const { voce, tema } of codaArticoli) {
        const sez = voce.sez;
        const infoFirma = risolviPersonaggio(CHI, voce.firma);
        const rawArt = await generaArticolo(voce, CHI, tema);
        const parsed = parseJSON(rawArt);
        if (!parsed?.articolo || parsed.articolo.length < 50) {
            scriviLog(`⚠️ SKIP articolo su "${tema.substring(0,30)}..."`);
            continue;
        }
        const commentiRaw = await generaCommenti(voce, CHI, relazioni, personaggi, parsed.articolo, [], LIMITI);
        let commenti = [];
        if (commentiRaw) {
            const parsedComm = parseJSON(commentiRaw);
            if (parsedComm?.commenti) {
                commenti = parsedComm.commenti;
                await aggiornaRelazioni(CHI, relazioni, personaggi, parsed.articolo, commenti);
            }
        }
        draft.sezioni[sez].articoli.push({
            tipo: voce.tipo==="GEN"?"gen":"rss",
            titolo: parsed.titolo || tema,
            articolo: parsed.articolo,
            commento_firma: { nome: voce.firma, avatar: infoFirma.avatar, testo: parsed.commento || "…" },
            commenti: commenti,
            categoria: voce.lab,
            colore_tipo: STILI[voce.tipo] || STILI["RSS"],
            immagine: infoFirma.img || "default_personaggio.webp"
        });
        articoliGenerati++;
        scriviLog(`  ✅ "${(parsed.titolo||tema).substring(0,50)}..." (${commenti.length} commenti)`);
    }
    // Chat
    const chatAbilitata = LIMITI.chat!=="sempre" ? !limiteSuperato(contatori, LIMITI, "chat_run_max") : true;
    const chattaOggi = chatAbilitata && Math.random()<0.30;
    if (chattaOggi) contatori.chat_run = (contatori.chat_run||0)+1;
    const chat = chattaOggi ? await generaChat(CHI, relazioni, personaggi) : null;
    if (chat) {
        const storico = caricaJSON(CHAT_PATH, []);
        storico.unshift({ data: oraAggiornamento, messaggi: chat });
        if (storico.length>30) storico.splice(30);
        salvaJSON(CHAT_PATH, storico);
        scriviLog(`💬 Chat salvata (${chat.length} messaggi)`);
    }
    // Aggiorna contatori totali
    contatori.chiamate_gemini_totali = (contatori.chiamate_gemini_totali||0) + contatoreChiamateApi;
    contatori.token_stimati_totali = (contatori.token_stimati_totali||0) + (contatoreChiamateApi*450);
    salvaJSON(CONTATORI_PATH, contatori);
    salvaJSON(RELAZIONI_PATH, relazioni);
    salvaJSON(PERSONAGGI_PATH, personaggi);
    // Articolo personaggio casuale
    const nomiPers = Object.keys(CHI).filter(n=>n!=="default");
    if (nomiPers.length) {
        const pers = nomiPers[Math.floor(Math.random()*nomiPers.length)];
        const dati = CHI[pers];
        const sysPers = `Sei ${pers} (${dati.mood}). ${dati.bio_breve?`Bio: "${dati.bio_breve}"` : ""}
Scrivi breve articolo (150-250 parole) su un argomento personale.
Rispondi JSON: {"titolo":"...","articolo":"..."}`;
        const rawPers = await callLLM(sysPers, "Scrivi articolo personale.", dati.peso??0.8);
        const parsedPers = parseJSON(rawPers);
        if (parsedPers?.titolo && parsedPers?.articolo) {
            const sezPers = Object.keys(draft.sezioni)[0] || "generale";
            if (!draft.sezioni[sezPers]) draft.sezioni[sezPers] = { color: "#005f73", articoli: [] };
            draft.sezioni[sezPers].articoli.push({
                tipo: "personaggio", titolo: parsedPers.titolo, articolo: parsedPers.articolo,
                commento_firma: { nome: pers, avatar: dati.avatar, testo: "" }, commenti: [],
                categoria: "Dalla Redazione", colore_tipo: STILI.GEN || "#2d6a4f",
                immagine: dati.img
            });
            articoliGenerati++;
            scriviLog(`✍️ Articolo personaggio da ${pers}: "${parsedPers.titolo.substring(0,50)}..."`);
        }
    }
    if (articoliGenerati === 0) {
        scriviLog("⚠️ Nessun articolo generato. Draft non modificato.");
        if (isNuovoGiorno && oldDraft) scriviLog(`   → Mantenuto draft del ${oldDraft.dataRiferimento}`);
        return;
    }
    const ok = safeWriteDraft(draft);
    if (ok) {
        contatori._primoRunOggi = true;
        salvaJSON(CONTATORI_PATH, contatori);
        scriviLog(`✅ FASE 1-v2 completata. ${articoliGenerati} nuovi articoli.`);
    } else {
        scriviLog("⚠️ Salvataggio draft fallito.");
    }
}

main()
    .then(() => { scriviLog("🏁 FINISH"); setTimeout(()=>process.exit(0),2000); })
    .catch(err => { scriviLog(`❌ CRITICAL ERROR: ${err.message}`); setTimeout(()=>process.exit(1),2000); });
