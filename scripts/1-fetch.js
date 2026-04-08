#!/usr/bin/env node
/**
 * 1-fetch.js
 * FASE 1: Legge la config, chiama Google News RSS e Gemini AI.
 * Salva il risultato grezzo in public/data/_draft.json per la fase 2.
 * 
 * Attivato da commit con [run-1], [run-2] o [run-3] nel messaggio,
 * oppure chiamato direttamente da 4-auto.js.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const LOG_PATH = path.join(DATA_DIR, "redazione.log");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DRAFT_PATH = path.join(DATA_DIR, "_draft.json");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const apiKey = process.env.GEMINI_API_KEY || "";
let activeGeminiModel = "gemini-1.5-flash";
let quotaGiornalieraEsaurita = false;
let contatoreChiamateApi = 0;

// Pulizia log: cancella solo se sono le 9 UTC o più tardi
// (il run delle 7 UTC non tocca il log del giorno precedente)
if (fs.existsSync(LOG_PATH)) {
    const oraUTC = new Date().getUTCHours();
    if (oraUTC >= 9) {
        const dataLog = new Date(fs.statSync(LOG_PATH).mtimeMs);
        const oggi = new Date();
        const logDiIeri = dataLog.toDateString() !== oggi.toDateString();
        // Cancella solo se il log è di ieri (o più vecchio) e siamo dopo le 9 UTC
        if (logDiIeri) {
            fs.unlinkSync(LOG_PATH);
            contatoreChiamateApi = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// UTILITÀ
// ---------------------------------------------------------------------------

function scriviLog(msg) {
    const ts = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const riga = `[${ts}] [1-fetch] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, riga);
    console.log(`> ${msg}`);
}

// ---------------------------------------------------------------------------
// RICERCA MODELLO GEMINI PIÙ RECENTE
// ---------------------------------------------------------------------------

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
            
            // Idea di gemini
            // 2. La nostra "scala gerarchica" di priorità
       
            scriviLog(`[DEBUG] Modelli che Google mi offre: ${modelliValidi.join(", ")}`);
        const preferiti = [
            "gemini-2.0-flash",        // Il top attuale nel tuo account
            "gemini-2.5-flash",        // Velocissimo e molto stabile
            "gemini-flash-latest",     // L'alias standard
            "gemini-2.5-flash-lite",   // La versione lite nuova
            "gemini-flash-lite-latest" // L'ultima spiaggia (quella lenta/busy)
        ];

            // 3. Il TEST: proviamo a scalare finché non ne troviamo uno libero
            for (const modello of preferiti) {
                if (modelliValidi.includes(modello)) {
                    try {
                        scriviLog(`[STRESS-TEST] Provo carico reale su: ${modello}...`);
                        
                        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent?key=${apiKey}`;
                        const testRes = await fetch(testUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                contents: [{ 
                                    parts: [{ text: "Analizza brevemente questa frase: 'Il Delfino di Pescara nuota nel mare Adriatico'." }] 
                                }],
                                generationConfig: { maxOutputTokens: 10 } // Query piccola ma che richiede "ragionamento"
                            })
                        }); 
                        if (testRes.status === 200) {
                            activeGeminiModel = modello;
                            scriviLog(`[OK] Modello agganciato e funzionante: [ ${activeGeminiModel} ]`);
                            return; // ABBIAMO TROVATO IL VINCITORE! Esci dalla funzione.
                        } else if (testRes.status === 503 || testRes.status === 429) {
                            scriviLog(`[BUSY] ${modello} è intasato (Errore ${testRes.status}). Scalo al prossimo...`);
                        }
                    } catch (err) {
                        scriviLog(`[SALTO] Errore tecnico su ${modello}, provo il prossimo.`);
                    }
                }
            } // Fine FOR

            // 4. Ultima spiaggia: se nessuno dei preferiti risponde, prova il primo della lista generale
            if (!activeGeminiModel && modelliValidi.length > 0) {
                activeGeminiModel = modelliValidi[0];
                scriviLog(`[AVVISO] Nessun preferito disponibile. Uso emergenza: ${activeGeminiModel}`);
            }
            // Idea di gemini fine
        } // Fine IF (data.models)
        
    } catch (e) {
        scriviLog(`[ATTENZIONE] Ricerca modelli fallita. Uso modello di riserva.`);
        activeGeminiModel = "gemini-1.5-flash-latest"; 
    }

    /* // IL TUO VECCHIO CODICE (COMMENTATO) RIMANE QUI SOTTO COME VOLEVI
    const modelliFlash = modelliValidi.filter(m => m.includes("flash"));
    modelliFlash.sort((a, b) => b.localeCompare(a));

    if (modelliFlash.length > 0) {
        activeGeminiModel = modelliFlash[0];
    } else if (modelliValidi.length > 0) {
        modelliValidi.sort((a, b) => b.localeCompare(a));
        activeGeminiModel = modelliValidi[0];
    }
    */
} // Fine FUNZIONE
// ---------------------------------------------------------------------------
// FETCH RSS — solo notizie fresche (max 48 ore)
// ---------------------------------------------------------------------------

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
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
            if (pubDateMatch) {
                const dataNotizia = new Date(pubDateMatch[1]).getTime();
                if (dataNotizia < dueGiorniFa) continue;
            }

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

// ---------------------------------------------------------------------------
// CHIAMATA GEMINI con retry e gestione quote
// ---------------------------------------------------------------------------

async function callGemini(sys, prompt) {
    if (!apiKey) {
        scriviLog("ERRORE: Manca la GEMINI_API_KEY nei Secrets di GitHub!");
        return null;
    }

    if (quotaGiornalieraEsaurita) {
        scriviLog("⏭️ Quota esaurita, salto chiamata API.");
        return null;
    }
    await new Promise(resolve => setTimeout(resolve, 30000));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKey}`;

    for (let i = 0; i < 3; i++) {
        try {
            contatoreChiamateApi++;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
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
                scriviLog(`[ERRORE API GEMINI] ${d.error.message}`);
                const msg = d.error.message.toLowerCase();

                // Quota giornaliera esaurita: rinuncia alle prossime chiamate ma continua il ciclo
                if (msg.includes("per day") || msg.includes("limit: 500")) {
                    scriviLog("❌ [QUOTA GIORNALIERA ESAURITA] Niente più chiamate API per oggi.");
                    quotaGiornalieraEsaurita = true;
                    return null;
                }

                // Quota al minuto: backoff esponenziale
                if (d.error.code === 429 || msg.includes("quota")) {
                    const msAttesa = Math.pow(2, i) * 30000;
                    scriviLog(`⏳ [LIMITE AL MINUTO] Attendo ${msAttesa / 1000}s...`);
                    await new Promise(r => setTimeout(r, msAttesa));
                    continue;
                }

                return null;
            }

            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) return null;
            return text;

        } catch (e) {
            scriviLog(`[ECCEZIONE callGemini tentativo ${i + 1}] ${e.message}`);
            if (i === 2) return null;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
    scriviLog("⚓️ FASE 1 — Avvio fetch RSS + Gemini...");

    await trovaUltimoModello();
    scriviLog(`🤖 Modello agganciato: [ ${activeGeminiModel} ]`);

    // Selezione config del giorno
    const fusoItalia = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const dataOggiItalia = new Date(fusoItalia);
    const giorni = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const oggi = giorni[dataOggiItalia.getDay()];

    let currentConfigPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(currentConfigPath)) currentConfigPath = CONFIG_PATH;

    if (!fs.existsSync(currentConfigPath)) {
        scriviLog(`ERRORE: ${currentConfigPath} non trovato!`);
        process.exit(1);
    }

    const CONFIG = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));

    const oraAggiornamento = new Date().toLocaleString('it-IT', {
        timeZone: 'Europe/Rome',
        hour: '2-digit', minute: '2-digit',
        day: '2-digit', month: '2-digit'
    });

    const sysPromptSatira = "Sei un giornalista satirico pescarese. Rispondi restituendo UN SINGOLO OGGETTO JSON ESATTO. Formato obbligatorio: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}. REQUISITO FONDAMENTALE: Il testo nel campo 'articolo' deve essere lungo, corposo e ben articolato (almeno 400-800 caratteri), sviluppando la notizia con ricchezza di dettagli e umorismo assurdo.Il 'commento' finale del Delfino può invece avere lo stesso tono della notizia";
    const sysPromptVera = "Sei un giornalista serio, fattuale e oggettivo. Rispondi restituendo UN SINGOLO OGGETTO JSON ESATTO. Formato obbligatorio: {\"titolo\":\"...\",\"articolo\":\"...\",\"commento\":\"...\"}. REQUISITO FONDAMENTALE: Il testo nel campo 'articolo' deve essere lungo, VERO, professionale e ben articolato (almeno 400-800 caratteri), basandoti unicamente sui fatti reali forniti. Niente invenzioni o satira nell'articolo. Il 'commento' finale del Delfino può invece avere un tono di un esperto in materia o ironico";

    // draft = struttura dati grezza che passa alla fase 2
    const draft = {
        oraAggiornamento,
        configUsata: currentConfigPath,
        sezioni: {}
    };

    for (const sez of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(sez)) continue;

        const categorie = CONFIG[sez];
        draft.sezioni[sez] = {
            color: categorie.color,
            articoli: []
        };

        let quotaAvanzata = 0;

        for (const [nome, info] of Object.entries(categorie)) {
            if (nome === "color" || info.count <= 0) continue;

            const targetPezzi = info.count + quotaAvanzata;
            quotaAvanzata = 0;

            scriviLog(`Lancio le reti per: ${nome} (target: ${targetPezzi})`);

            if (info.label === "Satira") {
                const temi = CONFIG.satira_config?.temi || ["Alieni a Pescara", "Arrosticini"];
                for (let i = 0; i < targetPezzi; i++) {
                    const tema = temi[Math.floor(Math.random() * temi.length)];
                    const raw = await callGemini(sysPromptSatira, `Inventa una notizia assurda su: ${tema}.`);
                    // Salviamo raw + metadati; parseJSON lo fa la fase 2
                    draft.sezioni[sez].articoli.push({
                        tipo: "satira",
                        raw,
                        fallback: {
                            titolo: `Mistero su: ${tema}`,
                            articolo: `Avevamo in serbo uno scoop clamoroso su "${tema}", ma un gabbiano ci ha rubato gli appunti.`,
                        },
                        categoria: info.label,
                        immagine: info.img
                    });
                }
            } else {
                const titoli = await fetchRSS(nome, targetPezzi);

                if (titoli.length < targetPezzi) {
                    quotaAvanzata = targetPezzi - titoli.length;
                    scriviLog(`[CASCATA] Solo ${titoli.length} notizie fresche per ${nome}. Passo ${quotaAvanzata} alla prossima categoria.`);
                }

                for (const t of titoli) {
                    const raw = await callGemini(sysPromptVera, `Scrivi un articolo giornalistico VERO e dettagliato basato su questa news reale: ${t}`);
                    draft.sezioni[sez].articoli.push({
                        tipo: "vera",
                        raw,
                        fallback: {
                            titolo: t,
                            articolo: `Notizia battuta dalle agenzie: "${t}". L'Intelligenza Artificiale è in pausa caffè.`,
                        },
                        categoria: info.label,
                        immagine: info.img
                    });
                }
            }
        }

        scriviLog(`Sezione ${sez}: ${draft.sezioni[sez].articoli.length} elementi raccolti.`);
    }

    scriviLog(`📊 Chiamate API Gemini effettuate in questo turno: ${contatoreChiamateApi}`);
    fs.writeFileSync(DRAFT_PATH, JSON.stringify(draft, null, 2));
    scriviLog(`✅ FASE 1 completata. Draft salvato in ${DRAFT_PATH}`);
}

main().catch(err => {
    scriviLog(`ERRORE CRITICO: ${err.message}`);
    process.exit(1);
});
