#!/usr/bin/env node
/**
 * 1-fetch-v2.js
 * FASE 1 — Nuova architettura v2
 *
 * Legge config_v2.json (struttura IMPOSTAZIONI/CHI/AGENDA/STILI/REDAZIONE/ICONE)
 * Gestisce personaggi con stati e relazioni dinamiche persistenti
 * Salva _draft-v2.json per 2-elabora-v2.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR   = path.join(__dirname, "..");
const DATA_DIR   = path.join(BASE_DIR, "public", "data");

const LOG_PATH         = path.join(DATA_DIR, "redazione-v2.log");
const CONFIG_PATH      = path.join(DATA_DIR, "config_v2.json");
const DRAFT_PATH       = path.join(DATA_DIR, "_draft-v2.json");
const RELAZIONI_PATH   = path.join(DATA_DIR, "_relazioni.json");
const PERSONAGGI_PATH  = path.join(DATA_DIR, "_personaggi.json");
const CHAT_PATH        = path.join(DATA_DIR, "_chat.json");
const CONTATORI_PATH   = path.join(DATA_DIR, "_contatori.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// STATO GLOBALE
// ---------------------------------------------------------------------------

const apiKey = process.env.GEMINI_API_KEY || "";
let activeGeminiModel = "gemini-1.5-flash";
let quotaGiornalieraEsaurita = false;
let contatoreChiamateApi = 0;

// ---------------------------------------------------------------------------
// PULIZIA LOG (ogni 48 ore leggendo la prima riga)
// ---------------------------------------------------------------------------

if (fs.existsSync(LOG_PATH)) {
    const primaRiga = fs.readFileSync(LOG_PATH, "utf8").split("\n")[0];
    const m = primaRiga.match(/\[(\d{2}\/\d{2}\/\d{4})/);
    if (m) {
        const [g, me, a] = m[1].split("/");
        const dataLog = new Date(`${a}-${me}-${g}`);
        if ((Date.now() - dataLog.getTime()) / 3600000 >= 48) {
            fs.unlinkSync(LOG_PATH);
            contatoreChiamateApi = 0;
        }
    }
}

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
// CARICA / SALVA JSON PERSISTENTI
// ---------------------------------------------------------------------------

function caricaJSON(filePath, defaultVal) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        scriviLog(`[WARN] Impossibile leggere ${filePath}: ${e.message}`);
    }
    return defaultVal;
}

function salvaJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// DECAY SETTIMANALE RELAZIONI
// Ogni run incrementa un contatore; ogni 14 run (2 volte/giorno × 7 giorni)
// le relazioni decadono del 10% verso 0.
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
                // Avvicina lo score a 0 del 10%
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
                .filter(m => m.name.includes("gemini") && m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            const flash = validi.filter(m => m.includes("flash")).sort((a, b) => b.localeCompare(a));
            if (flash.length > 0) activeGeminiModel = flash[0];
            else if (validi.length > 0) activeGeminiModel = validi.sort((a, b) => b.localeCompare(a))[0];
            scriviLog(`[MODELLO] ${activeGeminiModel}`);
        }
    } catch (e) {
        scriviLog(`[WARN] Ricerca modello fallita, uso default: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// FETCH RSS — notizie fresche (max 48 ore)
// ---------------------------------------------------------------------------

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml    = await res.text();
        // Nota: contatori non disponibile qui, viene aggiornato nel chiamante
        const titles = [];
        const dueGiorniFa  = Date.now() - 2 * 24 * 3600000;
        const itemRegex    = /<item>([\s\S]*?)<\/item>/gi;
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
        scriviLog(`Errore RSS per "${query}": ${e.message}`);
        return [];
    }
}

// Wrapper per fetchRSS che tiene il conteggio cumulativo
async function fetchRSSContato(query, max, contatori) {
    const risultati = await fetchRSS(query, max);
    contatori.rss_fetch_totali = (contatori.rss_fetch_totali || 0) + 1;
    return risultati;
}

// ---------------------------------------------------------------------------
// GESTIONE ERRORE QUOTA GEMINI
// ---------------------------------------------------------------------------

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
    if (!apiKey) { scriviLog("ERRORE: Manca GEMINI_API_KEY"); return null; }
    if (quotaGiornalieraEsaurita) { scriviLog("⏭️ Quota esaurita, salto."); return null; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKey}`;

    for (let i = 0; i < 3; i++) {
        try {
            contatoreChiamateApi++;
            // Le quote cumulative vengono aggiornate nel main dopo ogni run
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH",        threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_NONE" }
                    ]
                })
            });
            const d = await res.json();

            if (d.error) {
                scriviLog(`[ERRORE GEMINI] ${d.error.message} (code: ${d.error.code})`);
                const msg = d.error.message.toLowerCase();

                if (msg.includes("per day") || msg.includes("limit: 500")) {
                    scriviLog("❌ QUOTA GIORNALIERA ESAURITA");
                    quotaGiornalieraEsaurita = true;
                    return null;
                }
                if (d.error.code === 429 || d.error.code === 503) {
                    if (msg.includes("quota exceeded")) { await gestisciErroreQuota(d.error.message); continue; }
                    const ms = Math.pow(2, i) * 10000;
                    scriviLog(`⏳ Errore ${d.error.code}, attendo ${ms / 1000}s...`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                return null;
            }

            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            return text || null;

        } catch (e) {
            scriviLog(`[ECCEZIONE tentativo ${i + 1}] ${e.message}`);
            await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
            if (i === 2) return null;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// RISOLVE GIORNO CORRENTE
// ---------------------------------------------------------------------------

function giornoOggi() {
    const fusoItalia = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" });
    const d = new Date(fusoItalia);
    return ["dom", "lun", "mar", "mer", "gio", "ven", "sab"][d.getDay()];
}

// ---------------------------------------------------------------------------
// RISOLVE AGENDA DEL GIORNO
// ---------------------------------------------------------------------------

function risolviAgenda(AGENDA, oggi) {
    for (const [chiave, val] of Object.entries(AGENDA)) {
        if (chiave === "default") continue;
        const giorni = chiave.split(",").map(g => g.trim());
        if (giorni.includes(oggi)) return { ...AGENDA.default, ...val };
    }
    return AGENDA.default;
}

// ---------------------------------------------------------------------------
// RISOLVE PERSONAGGIO (con fallback a default)
// ---------------------------------------------------------------------------

function risolviPersonaggio(CHI, nome) {
    return CHI[nome] || CHI["default"] || { mood: "neutro", peso: 0.5, avatar: "🐬" };
}

// ---------------------------------------------------------------------------
// GENERA ARTICOLO (RSS o GEN)
// ---------------------------------------------------------------------------

async function generaArticolo(voce, CHI, titolo) {
    const firma = risolviPersonaggio(CHI, voce.firma);
    const moodFirma = firma.mood || "neutro";
    const bioFirma = (firma.bio_breve || firma.bio) ? `La tua storia: "${firma.bio_breve || firma.bio}".` : "";
    const moodCommento = voce.mood ? `Il tono del commento finale deve essere: ${voce.mood}` : "";
    const isGenerato = voce.tipo === "GEN";
    const imgFirma = firma.img; // <<<<<<<<<<<<<======================================================
    // inventare è indipendente dal tipo — può essere true sia su GEN che su RSS

    // fantasia: true = inventa liberamente | false/assente = scrive cose vere (anche se senza RSS)
    const puoInventare = voce.fantasia === true;

    const sys = `Sei ${voce.firma}, giornalista con questo carattere: "${moodFirma}". ${bioFirma}
Rispondi con UN SINGOLO OGGETTO JSON: {"titolo":"...","articolo":"...","commento":"..."}.
L'articolo deve essere di circa ${voce._parole || 400} parole, scritto con la tua voce e il tuo stile.
${puoInventare
    ? "Puoi inventare liberamente: non sei vincolato a fatti reali. Usa la tua fantasia, esagera, crea situazioni assurde coerenti col tuo carattere."
    : "Scrivi cose reali e veritiere. Puoi commentare, interpretare e usare il tuo stile, ma niente invenzioni o fatti falsi."}
IMPORTANTE: non fare MAI riferimenti temporali specifici come oggi, ieri, questa mattina, in questo momento, adesso, attualmente, nelle ultime ore, questa settimana. L'articolo deve essere valido in qualsiasi momento venga letto.
${moodCommento}`;

    const userPrompt = isGenerato
        ? `Scrivi un articolo su questo tema: ${titolo}`
        : `Scrivi un articolo basato su questa notizia reale: ${titolo}`;

    return await callGemini(sys, userPrompt, voce.weight_articolo ?? 0.8);
}

// ---------------------------------------------------------------------------
// GENERA COMMENTI A CASCATA
// ---------------------------------------------------------------------------

async function generaCommenti(voce, CHI, relazioni, personaggi, articolo, commentiPrecedenti, LIMITI = {}) {
    if (quotaGiornalieraEsaurita) return null;

    // Costruisce il contesto dei personaggi disponibili
    const nomiPersonaggi = Object.keys(CHI).filter(n => n !== "default");

    // Costruisce il contesto delle relazioni rilevanti
    const contestoRelazioni = nomiPersonaggi.flatMap(a =>
        nomiPersonaggi.filter(b => b !== a).map(b => {
            const k = `${a}→${b}`;
            const r = relazioni[k];
            return r ? `${a} è ${r.label} verso ${b} (score: ${r.score})` : null;
        }).filter(Boolean)
    ).join(". ");

    // Costruisce il contesto degli stati
    const contestoStati = nomiPersonaggi.map(n => {
        const p = personaggi[n];
        return p?.stato && p.stato !== "normale"
            ? `${n} è attualmente: ${p.stato} (umore: ${p.umore || "neutro"})`
            : null;
    }).filter(Boolean).join(". ");

    // Costruisce il contesto dei commenti precedenti
    const contestoCommenti = commentiPrecedenti?.length
        ? `Commenti precedenti:\n${commentiPrecedenti.map(c => `${c.nome} (${c.avatar}): "${c.testo}"`).join("\n")}`
        : "";

    const sys = `Sei il moderatore della redazione de La Voce del Delfino. 
I personaggi disponibili sono: ${nomiPersonaggi.map(n => {
        const p = CHI[n];
        const bio = (p.bio_breve || p.bio) ? ` Bio: "${p.bio_breve || p.bio}"` : "";
        return `${n} (${p.avatar}, mood: "${p.mood}".${bio})`;
    }).join(", ")}.
Relazioni: ${contestoRelazioni || "nessuna relazione stabilita"}.
Stati: ${contestoStati || "tutti nella norma"}.
${contestoCommenti}

Scegli da ${LIMITI.commenti_min ?? 1} a ${LIMITI.commenti_max ?? 3} personaggi che commenterebbero questa notizia in modo coerente col loro carattere e le loro relazioni.
Ogni personaggio commenta la notizia E i commenti precedenti (se presenti).
IMPORTANTE: il personaggio "${voce.firma}" ha già scritto l'articolo — NON può commentare se stesso.
Se un personaggio è in sciopero, decidi autonomamente se partecipa o meno.
Rispondi SOLO con JSON: {"commenti": [{"nome":"...","avatar":"...","testo":"..."}]}`;

    const userPrompt = `Articolo: "${articolo}"\n\nGenera i commenti dei personaggi.`;

    return await callGemini(sys, userPrompt, voce.weight_commento ?? 0.7);
}

// ---------------------------------------------------------------------------
// AGGIORNA RELAZIONI E STATI dopo i commenti
// ---------------------------------------------------------------------------

async function aggiornaRelazioni(CHI, relazioni, personaggi, articolo, commenti) {
    if (quotaGiornalieraEsaurita || !commenti?.length) return;

    const nomiPresenti = commenti.map(c => c.nome);
    const nomiPersonaggi = Object.keys(CHI).filter(n => n !== "default");

    const sys = `Sei un analista delle dinamiche sociali della redazione de La Voce del Delfino.
Analizza questa interazione e restituisci i delta delle relazioni e gli eventuali cambi di stato.
Rispondi SOLO con JSON:
{
  "delta_relazioni": [{"da":"...","a":"...","delta": 0.1}],
  "nuovi_stati": [{"nome":"...","stato":"...","umore":"..."}]
}
I delta vanno da -0.3 a +0.3. Gli stati sono liberi (es. "arrabbiato", "in sciopero", "entusiasta", "normale").`;

    const userPrompt = `Articolo: "${articolo.substring(0, 300)}..."
Commenti:
${commenti.map(c => `${c.nome}: "${c.testo}"`).join("\n")}

Analizza le dinamiche e restituisci i delta.`;

    const raw = await callGemini(sys, userPrompt);
    if (!raw) return;

    try {
        const inizio = raw.indexOf("{"), fine = raw.lastIndexOf("}");
        const parsed = JSON.parse(raw.substring(inizio, fine + 1));

        // Applica delta relazioni
        for (const d of (parsed.delta_relazioni || [])) {
            const chiave = `${d.da}→${d.a}`;
            if (!relazioni[chiave]) relazioni[chiave] = { score: 0, label: "neutro", ultimo_aggiornamento: "" };
            relazioni[chiave].score = parseFloat(Math.max(-1, Math.min(1, relazioni[chiave].score + d.delta)).toFixed(3));
            relazioni[chiave].label = labelDaScore(relazioni[chiave].score);
            relazioni[chiave].ultimo_aggiornamento = new Date().toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });
        }

        // Applica nuovi stati personaggi
        for (const s of (parsed.nuovi_stati || [])) {
            if (!personaggi[s.nome]) personaggi[s.nome] = {};
            personaggi[s.nome].stato = s.stato;
            personaggi[s.nome].umore = s.umore;
            personaggi[s.nome].dal = new Date().toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });
        }

        scriviLog(`🔄 Relazioni aggiornate: ${(parsed.delta_relazioni || []).length} delta, ${(parsed.nuovi_stati || []).length} stati cambiati.`);
    } catch (e) {
        scriviLog(`[WARN] Impossibile parsare aggiornamento relazioni: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// PARSE JSON GREZZO DA GEMINI
// ---------------------------------------------------------------------------

function parseJSON(raw) {
    if (!raw) return null;
    try {
        const ia = raw.indexOf("["), fa = raw.lastIndexOf("]");
        const io = raw.indexOf("{"), fo = raw.lastIndexOf("}");
        if (ia !== -1 && fa !== -1 && (io === -1 || ia < io)) {
            const arr = JSON.parse(raw.substring(ia, fa + 1));
            return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
        }
        if (io !== -1 && fo !== -1) return JSON.parse(raw.substring(io, fo + 1));
    } catch (e) {}
    return null;
}


// ---------------------------------------------------------------------------
// GENERA CHAT INTERNA DI REDAZIONE
// Una conversazione casuale tra i personaggi, basata su relazioni e stati.
// Spunto casuale: lamentela su un commento, gossip, battibecco, elogio ironico.
// ---------------------------------------------------------------------------

async function generaChat(CHI, relazioni, personaggi) {
    if (quotaGiornalieraEsaurita) return null;

    const nomi = Object.keys(CHI).filter(n => n !== "default");
    if (nomi.length < 2) return null;

    // Contesto relazioni
    const contestoRelazioni = nomi.flatMap(a =>
        nomi.filter(b => b !== a).map(b => {
            const r = relazioni[`${a}\u2192${b}`];
            return r ? `${a} è ${r.label} verso ${b}` : null;
        }).filter(Boolean)
    ).join(". ");

    // Contesto stati
    const contestoStati = nomi.map(n => {
        const p = personaggi[n];
        return p?.stato && p.stato !== "normale"
            ? `${n} è: ${p.stato} (umore: ${p.umore || "neutro"})`
            : null;
    }).filter(Boolean).join(". ");

    // Spunti casuali per la chat
    const spunti = [
        "qualcuno si lamenta di un commento scritto da un collega",
        "qualcuno chiede spiegazioni su un articolo pubblicato",
        "c'è un piccolo battibecco su chi ha preso il caffè dell'altro",
        "qualcuno elogia ironicamente il lavoro di un collega",
        "qualcuno si lamenta del carico di lavoro",
        "qualcuno commenta il meteo di Pescara con aria drammatica",
        "qualcuno annuncia che va in pausa e nessuno è contento",
        "c'è una discussione su chi ha sbagliato il titolo di un articolo"
    ];
    const spunto = spunti[Math.floor(Math.random() * spunti.length)];

    const sys = `Sei il narratore della chat interna della redazione de La Voce del Delfino.
I personaggi sono: ${nomi.map(n => {
        const p = CHI[n];
        const bio = (p.bio_breve || p.bio) ? ` Bio: "${p.bio_breve || p.bio}"` : "";
        return `${n} (${p.avatar}, carattere: "${p.mood}".${bio})`;
    }).join(", ")}.
Relazioni: ${contestoRelazioni || "nessuna stabilita"}.
Stati: ${contestoStati || "tutti nella norma"}.

Genera una breve conversazione in chat (4-8 messaggi) tra 2-3 di questi personaggi.
Lo spunto è: ${spunto}.
Ogni messaggio deve riflettere il carattere del personaggio e le sue relazioni con gli altri.
Rispondi SOLO con JSON:
{"chat": [{"nome":"...","avatar":"...","testo":"..."}]}`;

    const raw = await callGemini(sys, "Genera la chat di oggi in redazione.");
    if (!raw) return null;

    try {
        const io = raw.indexOf("{"), fo = raw.lastIndexOf("}");
        const parsed = JSON.parse(raw.substring(io, fo + 1));
        return parsed.chat || null;
    } catch (e) {
        scriviLog(`[WARN] Impossibile parsare chat: ${e.message}`);
        return null;
    }
}


// ---------------------------------------------------------------------------
// CONTATORI GIORNALIERI E FASCE ORARIE
// ---------------------------------------------------------------------------

function caricaContatori(LIMITI) {
    const oraRoma = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
    const oggi = oraRoma.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" });
    const oraCorrente = oraRoma.getHours();
    const minutiCorrente = oraRoma.getMinutes();
    const contatori = caricaJSON(CONTATORI_PATH, {});

    // Fascia reset quote (ora intera italiana, es. "05" = alle 05:00)
    const fasciaReset = parseInt(LIMITI.fascia_reset_quote ?? "05");
    const tolleranza = LIMITI.tolleranza_minuti ?? 30;
    const inFasciaReset = Math.abs((oraCorrente * 60 + minutiCorrente) - fasciaReset * 60) <= tolleranza;

    // Reset se: nuovo giorno OPPURE siamo nella fascia reset e non l'abbiamo ancora fatto oggi
    const deveResettare = contatori.data !== oggi ||
        (inFasciaReset && !contatori.reset_eseguito_oggi);

    if (deveResettare) {
        scriviLog(`🔄 Reset quote cumulative (${oggi} ${String(oraCorrente).padStart(2,"0")}:${String(minutiCorrente).padStart(2,"0")} IT).`);
        return {
            data: oggi,
            reset_eseguito_oggi: inFasciaReset,
            cerca_modello: 0,
            chat_run: 0,
            chiamate_gemini: 0,
            token_stimati: 0,
            rss_fetch: 0
        };
    }
    return contatori;
}

function limiteSuperato(contatori, LIMITI, tipo) {
    const limite = LIMITI[tipo];
    if (limite === "sempre" || limite === undefined) return false;
    const contatore = contatori[tipo.replace("_max", "")] || 0;
    return contatore >= limite;
}

/**
 * Controlla se l'ora corrente italiana rientra in una delle fasce configurate.
 * Tolleranza in minuti: se fascia="06" e tolleranza=45, accetta dalle 05:15 alle 06:45.
 */
function fasciaDiArticoliAttiva(LIMITI) {
    const fasce = LIMITI.fasce_articoli;
    if (!fasce || fasce.length === 0) return true; // nessun limite = sempre attivo

    const oraRoma = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
    const minutiOra = oraRoma.getHours() * 60 + oraRoma.getMinutes();
    const tolleranza = LIMITI.tolleranza_minuti ?? 30;

    return fasce.some(f => {
        const fasciaMinuti = parseInt(f) * 60;
        return Math.abs(minutiOra - fasciaMinuti) <= tolleranza;
    });
}

/**
 * Converte lunghezza_articolo (1-10) in numero di parole target.
 * 1 = ~80 parole, 10 = ~800 parole
 */
function paroleTarget(LIMITI) {
    const livello = Math.max(1, Math.min(10, LIMITI.lunghezza_articolo ?? 5));
    return Math.round(80 + (livello - 1) * 80);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
    const oraItalia = new Intl.DateTimeFormat("it-IT", {
        timeZone: "Europe/Rome", dateStyle: "full", timeStyle: "medium"
    }).format(new Date());
    scriviLog(`═══════════════════════════════════`);
    scriviLog(`🐬 NUOVO RUN v2 [ ${oraItalia} ]`);
    scriviLog(`═══════════════════════════════════`);
    scriviLog("⚓️ FASE 1-v2 — Avvio...");

    // --- Carica config ---
    if (!fs.existsSync(CONFIG_PATH)) {
        scriviLog(`ERRORE: ${CONFIG_PATH} non trovato!`);
        process.exit(1);
    }
    const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const { IMPOSTAZIONI, CHI, AGENDA, STILI, REDAZIONE, ICONE } = CONFIG;

    // --- Limiti, contatori e fasce ---
    const LIMITI = CONFIG.LIMITI || {};
    const contatori = caricaContatori(LIMITI);
    const articoliAttivi = fasciaDiArticoliAttiva(LIMITI);
    const parole = paroleTarget(LIMITI);
    scriviLog(`📊 Quote cumulative oggi: chiamate_gemini=${contatori.chiamate_gemini ?? 0}, rss_fetch=${contatori.rss_fetch ?? 0}, token_stimati≈${contatori.token_stimati ?? 0}`);
    scriviLog(`🕐 Fascia articoli attiva: ${articoliAttivi ? "SÌ" : "NO"} | Lunghezza target: ~${parole} parole`);

    // --- Cerca modello — sempre, senza condizioni ---
    await trovaUltimoModello();

    // --- Giorno corrente e agenda ---
    const oggi = giornoOggi();
    const agenda = risolviAgenda(AGENDA, oggi);
    scriviLog(`📅 Giorno: ${oggi} | Timbro: ${agenda.timbro}`);

    // --- Ora aggiornamento ---
    const oraAggiornamento = new Date().toLocaleString("it-IT", {
        timeZone: "Europe/Rome",
        hour: "2-digit", minute: "2-digit",
        day: "2-digit", month: "2-digit"
    });

    // --- Carica persistenti ---
    let relazioni  = caricaJSON(RELAZIONI_PATH, { _runCount: 0 });
    let personaggi = caricaJSON(PERSONAGGI_PATH, {});

    // Inizializza personaggi mancanti
    for (const nome of Object.keys(CHI).filter(n => n !== "default")) {
        if (!personaggi[nome]) personaggi[nome] = { stato: "normale", umore: "neutro", dal: null };
    }

    // Applica decay settimanale
    relazioni = applicaDecay(relazioni);

    // --- Primo aggiornamento del giorno: cancella il draft precedente ---
    const isPrimoRun = contatori._primoRunOggi !== true;
    if (isPrimoRun) {
        if (fs.existsSync(DRAFT_PATH)) {
            fs.unlinkSync(DRAFT_PATH);
            scriviLog("🌅 Primo aggiornamento del giorno — draft precedente cancellato.");
        }
        contatori._primoRunOggi = true;
    }

    // --- Filtra REDAZIONE per oggi ---
    const vociAttive = REDAZIONE.filter(voce => {
        if (voce.g === "default") return true;
        const giorniVoce = voce.g.split(",").map(g => g.trim());
        return giorniVoce.includes(oggi);
    });

    scriviLog(`📋 Voci attive oggi: ${vociAttive.length}`);

    // --- Draft ---
    const draft = {
        oraAggiornamento,
        agenda,
        impostazioni: IMPOSTAZIONI,
        stili: STILI,
        sezioni: {}
    };

    // Raggruppa per sezione
    for (const voce of vociAttive) {
        const sez = voce.sez;
        if (!draft.sezioni[sez]) {
            draft.sezioni[sez] = {
                color: STILI[sez] || STILI["RSS"] || "#005f73",
                articoli: []
            };
        }
    }

    // --- Genera articoli (se entro il limite giornaliero) ---
    const articoliAbilitati = !limiteSuperato(contatori, LIMITI, "articoli_run_max");
    if (!articoliAbilitati) {
        scriviLog(`⏭️ Generazione articoli saltata (limite: ${LIMITI.articoli_run_max} run/giorno raggiunto).`);
    }
    contatori.articoli_run = (contatori.articoli_run || 0) + (articoliAbilitati ? 1 : 0);

    // Ogni tema da generare porta con sé la voce di appartenenza — così
    // la cascata non mescola mai metadati (firma, label, icona) tra voci diverse.
    // [ { voce, tema } ]
    const codaArticoli = [];

    if (articoliAbilitati) {
        let quotaAvanzata = 0;
        let voceQuota = null; // la voce che ha generato la quota avanzata

        for (const voce of vociAttive) {
            const num = (voce.num || 1) + (voceQuota?.sez === voce.sez ? quotaAvanzata : 0);
            quotaAvanzata = 0;
            voceQuota = null;

            voce._parole = parole; // lunghezza target dal config
        scriviLog(`🎣 [${voce.sez}] ${voce.arg} — tipo: ${voce.tipo}, num: ${num}, firma: ${voce.firma}, ~${parole} parole`);

            if (voce.tipo === "GEN") {
                const temi = voce.temi || [voce.arg];
                for (let i = 0; i < num; i++) {
                    codaArticoli.push({ voce, tema: temi[Math.floor(Math.random() * temi.length)] });
                }
            } else {
                const titoli = await fetchRSS(voce.arg, num);
                const mancanti = num - titoli.length;
                if (mancanti > 0) {
                    scriviLog(`[CASCATA] Solo ${titoli.length}/${num} notizie per "${voce.arg}". Passo ${mancanti} alla voce successiva.`);
                    quotaAvanzata = mancanti;
                    voceQuota = voce; // ricorda CHI ha ceduto la quota
                }
                for (const t of titoli) {
                    codaArticoli.push({ voce, tema: t }); // metadati sempre della voce corrente
                }
            }
        }
    }

    // --- Genera articoli dalla coda ---
    for (const { voce, tema } of codaArticoli) {
        const sez        = voce.sez;
        const icona      = ICONE[voce.lab] || ICONE["default"] || "Categoria.webp";
        const coloreTipo = STILI[voce.tipo] || STILI["RSS"];

        // 1. Genera articolo
        const rawArticolo    = await generaArticolo(voce, CHI, tema);
        const parsedArticolo = parseJSON(rawArticolo);

        const articoloTesto  = parsedArticolo?.articolo ||
            (voce.tipo === "GEN"
                ? `Avevamo uno scoop su "${tema}", ma un gabbiano ha rubato gli appunti.`
                : `Notizia: "${tema}". L'IA è in pausa caffè.`);
        const titoloFinale   = parsedArticolo?.titolo || tema;
        const commentoFirma  = parsedArticolo?.commento || "…";

        // 2. Genera commenti a cascata dei personaggi
        let commentiFinali = [];
        const rawCommenti    = await generaCommenti(voce, CHI, relazioni, personaggi, articoloTesto, []);
        const parsedCommenti = parseJSON(rawCommenti);
        if (parsedCommenti?.commenti?.length) {
            commentiFinali = parsedCommenti.commenti;
            // 3. Aggiorna relazioni e stati
            await aggiornaRelazioni(CHI, relazioni, personaggi, articoloTesto, commentiFinali);
        }

        // 4. Push nel draft — immagine dal config IMMAGINI per tipo, fallback su icona categoria
        const IMMAGINI = CONFIG.IMMAGINI || {};
        const tipoChiave = voce.tipo === "GEN" ? "gen" : "rss";
        const immagineTipo = IMMAGINI[tipoChiave] || icona;
        draft.sezioni[sez].articoli.push({
            tipo:           voce.tipo === "GEN" ? "gen" : "rss",
            titolo:         titoloFinale,
            articolo:       articoloTesto,
            commento_firma: { nome: voce.firma, avatar: risolviPersonaggio(CHI, voce.firma).avatar, testo: commentoFirma },
            commenti:       commentiFinali,
            categoria:      voce.lab,
            colore_tipo:    coloreTipo,
            immagine:       imgFirma
        });

        scriviLog(`  ✅ "${titoloFinale.substring(0, 50)}..." — ${commentiFinali.length} commenti`);
    }

    // --- Nuovi commenti su notizie congelate (run oltre il limite articoli) ---
    if (!articoliAttivi && fs.existsSync(DRAFT_PATH)) {
        scriviLog("🧊 Articoli congelati — aggiungo commenti alle notizie esistenti...");
        const draftEsistente = caricaJSON(DRAFT_PATH, { sezioni: {} });

        for (const [sez, datiSez] of Object.entries(draftEsistente.sezioni || {})) {
            for (const articolo of (datiSez.articoli || [])) {
                // Trova la voce corrispondente per avere il contesto giusto
                const voceRef = vociAttive.find(v => v.sez === sez && v.lab === articolo.categoria) || vociAttive.find(v => v.sez === sez);
                if (!voceRef) continue;

                const rawCommenti    = await generaCommenti(voceRef, CHI, relazioni, personaggi, articolo.articolo, articolo.commenti || [], LIMITI);
                const parsedCommenti = parseJSON(rawCommenti);
                if (parsedCommenti?.commenti?.length) {
                    // Accoda i nuovi commenti a quelli esistenti (max 6 totali)
                    const maxTotali = LIMITI.commenti_max_totali ?? 6;
                    articolo.commenti = [...(articolo.commenti || []), ...parsedCommenti.commenti].slice(0, maxTotali);
                    await aggiornaRelazioni(CHI, relazioni, personaggi, articolo.articolo, parsedCommenti.commenti);
                    scriviLog(`  💬 Nuovi commenti aggiunti a: "${articolo.titolo.substring(0, 40)}..."`);
                }
            }
            // Aggiorna draft con i nuovi commenti
            if (!draft.sezioni[sez]) draft.sezioni[sez] = datiSez;
            else draft.sezioni[sez].articoli = datiSez.articoli;
        }
    }

    // --- Genera chat interna di redazione (30% di probabilità per run) ---
    const chatAbilitata = LIMITI.chat !== "sempre"
        ? !limiteSuperato(contatori, LIMITI, "chat_run_max")
        : true;
    const chattaOggi = chatAbilitata && Math.random() < 0.30;
    scriviLog(`💬 Chat oggi: ${chattaOggi ? "sì" : !chatAbilitata ? "no (limite raggiunto)" : "no (skip casuale)"}`);
    if (chattaOggi) contatori.chat_run = (contatori.chat_run || 0) + 1;
    const chatOggi = chattaOggi ? await generaChat(CHI, relazioni, personaggi) : null;
    const chatStorico = caricaJSON(CHAT_PATH, []);
    if (chatOggi) {
        chatStorico.unshift({
            data: oraAggiornamento,
            messaggi: chatOggi
        });
        // Mantieni solo le ultime 30 chat
        if (chatStorico.length > 30) chatStorico.splice(30);
        salvaJSON(CHAT_PATH, chatStorico);
        scriviLog(`💬 Chat salvata: ${chatOggi.length} messaggi.`);
    }

    // --- Aggiorna quote cumulative e salva contatori ---
    contatori.chiamate_gemini_totali = (contatori.chiamate_gemini_totali || 0) + contatoreChiamateApi;
    // Stima token: ~450 token per chiamata (input+output medio)
    contatori.token_stimati_totali = (contatori.token_stimati_totali || 0) + (contatoreChiamateApi * 450);
    contatori.cerca_modello = (contatori.cerca_modello || 0);
    contatori.chat_run = (contatori.chat_run || 0);
    scriviLog(`📊 Totale giornata: chiamate=${contatori.chiamate_gemini_totali}, token_stimati≈${contatori.token_stimati_totali}, rss=${contatori.rss_fetch_totali ?? 0}`);
    salvaJSON(CONTATORI_PATH, contatori);

    // --- Salva persistenti aggiornati ---
    salvaJSON(RELAZIONI_PATH, relazioni);
    salvaJSON(PERSONAGGI_PATH, personaggi);
    scriviLog(`💾 Relazioni e personaggi salvati.`);

    // --- Articolo personaggio: un personaggio casuale scrive qualcosa che gli piace ---
    scriviLog("✍️ Generazione articolo personaggio casuale...");
    const nomiPersonaggi = Object.keys(CHI).filter(n => n !== "default");
    const personaggioCasuale = nomiPersonaggi[Math.floor(Math.random() * nomiPersonaggi.length)];
    const datiPersonaggio = CHI[personaggioCasuale];
    const sysPersonaggio = `Sei ${personaggioCasuale}, con questo carattere: "${datiPersonaggio.mood}". ${datiPersonaggio.bio_breve ? `La tua storia: "${datiPersonaggio.bio_breve}".` : ""}
Scrivi un breve articolo (150-250 parole) su qualcosa che ti piace, ti ha colpito o ti ha fatto arrabbiare oggi.
Scegli tu l'argomento in base alla tua personalità.
Rispondi SOLO con JSON: {"titolo":"...","articolo":"..."}`;
    const rawPersonaggio = await callGemini(sysPersonaggio, "Scrivi il tuo articolo personale di oggi.", datiPersonaggio.peso ?? 0.8);
    if (rawPersonaggio) {
        const parsedPersonaggio = parseJSON(rawPersonaggio);
        if (parsedPersonaggio?.titolo && parsedPersonaggio?.articolo) {
            // Trova la prima sezione disponibile nel draft
            const sezPers = Object.keys(draft.sezioni)[0] || "pescara";
            if (!draft.sezioni[sezPers]) draft.sezioni[sezPers] = { color: STILI[sezPers] || "#005f73", articoli: [] };
            const immaginePersonaggio = (CONFIG.IMMAGINI || {}).personaggio || null;
            draft.sezioni[sezPers].articoli.push({
                tipo: "personaggio",
                titolo: parsedPersonaggio.titolo,
                articolo: parsedPersonaggio.articolo,
                commento_firma: { nome: personaggioCasuale, avatar: datiPersonaggio.avatar, testo: "" },
                commenti: [],
                categoria: "Dalla Redazione",
                colore_tipo: STILI.GEN || "#2d6a4f",
                immagine: immaginePersonaggio
            });
            scriviLog(`✍️ Articolo personaggio scritto da ${personaggioCasuale}: "${parsedPersonaggio.titolo.substring(0,50)}..."`);
        }
    }

    // --- Salva draft ---
    scriviLog(`📊 Chiamate API totali: ${contatoreChiamateApi}`);
    salvaJSON(DRAFT_PATH, draft);
    scriviLog(`✅ FASE 1-v2 completata. Draft → ${DRAFT_PATH}`);
}

main()
    .then(() => {
        scriviLog("🏁 [FINISH] Tutto salvato. Forzo chiusura processo.");
        // Il timeout di 500ms assicura che i log vengano scritti su disco prima di killare
        setTimeout(() => process.exit(0), 2000); 
    })
    .catch(err => {
        scriviLog(`❌ [CRITICAL ERROR] ${err.message}`);
        setTimeout(() => process.exit(1), 2000);
    });
