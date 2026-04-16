#!/usr/bin/env node
/**
 * FILE: 1-fetch-v4.js
 * DATA: 2025-04-16
 * VERSIONE: 4.20
 * DESCRIZIONE: Orchestratore principale per la generazione degli articoli.
 *              Supporta Gemini e Groq, fallback persistente, reset opzionale.
 *              Tipi supportati: RSS, GEN, RED (Dalla Redazione).
 *              DEDUPLICAZIONE: evita di rigenerare articoli già pubblicati oggi.
 *              LOG: se assente lo crea, se più vecchio di 2 giorni lo cancella.
 *              DATA ARTICOLI: formato "giorno mese ora:minuti" con sigla fonte.
 *              RED CASUALI: generazione automatica di articoli redazionali casuali.
 *              PRIORITÀ GEMINI: Groq viene testato SOLO se Gemini non è disponibile.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(BASE_DIR, "public", "data");

const LOG_PATH = path.join(DATA_DIR, "redazione-v2.log");
const CONFIG_PATH = path.join(DATA_DIR, "config_v2.json");
const DRAFT_PATH = path.join(DATA_DIR, "_draft-v2.json");
const RELAZIONI_PATH = path.join(DATA_DIR, "_relazioni.json");
const PERSONAGGI_PATH = path.join(DATA_DIR, "_personaggi.json");
const CHAT_PATH = path.join(DATA_DIR, "_chat.json");
const CONTATORI_PATH = path.join(DATA_DIR, "_contatori.json");
const PROVIDER_STATE_PATH = path.join(DATA_DIR, "_provider_state.json");
const TEMP_PATH = DRAFT_PATH + ".tmp";
const BACKUP_PATH = DRAFT_PATH + ".bak";

import { scriviLog, caricaJSON, salvaJSON, parseJSON, 
         giornoOggi, risolviAgenda, risolviPersonaggio, 
         caricaContatori, limiteSuperato, fasciaDiArticoliAttiva, paroleTarget, contaArticoli } from "./lib/utils.js";
import { initConfig, loadConfig, getVociAttive } from "./lib/config.js";
import { initNews, raccoltaNotizie } from "./lib/news.js";
import { initLLM, callLLM, initModels, setScheduledRun, incrementConsecutiveFailures, resetConsecutiveFailures, getCurrentProvider, setActiveGeminiModel, getTestedGeminiModel } from "./lib/llm.js";
import { initDraft, caricaDraft, inizializzaSezioni, safeWriteDraft } from "./lib/draft.js";
import { initRelations, applicaDecay, aggiornaRelazioni } from "./lib/relations.js";
import { initChat, generaChat } from "./lib/chat.js";
import { initArticoli, generaArticolo, generaCommenti } from "./lib/articoli.js";

function log(msg) { scriviLog(msg, LOG_PATH); }

// Formatta la data nel formato "gio 17 aprile 20:43"
function formatDataArticolo(publishedAt, sourceSigla) {
    if (!publishedAt) return sourceSigla ? `${sourceSigla} data sconosciuta` : null;
    
    const date = new Date(publishedAt);
    if (isNaN(date.getTime())) return sourceSigla ? `${sourceSigla} data non valida` : null;
    
    const giorni = { 0: "dom", 1: "lun", 2: "mar", 3: "mer", 4: "gio", 5: "ven", 6: "sab" };
    const mesi = { 0: "gennaio", 1: "febbraio", 2: "marzo", 3: "aprile", 4: "maggio", 5: "giugno", 
                   6: "luglio", 7: "agosto", 8: "settembre", 9: "ottobre", 10: "novembre", 11: "dicembre" };
    
    const romaDate = new Date(date.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
    const giorno = giorni[romaDate.getDay()];
    const giornoMese = romaDate.getDate();
    const mese = mesi[romaDate.getMonth()];
    const ore = romaDate.getHours().toString().padStart(2, '0');
    const minuti = romaDate.getMinutes().toString().padStart(2, '0');
    
    return `${sourceSigla} ${giorno} ${giornoMese} ${mese} ${ore}:${minuti}`;
}

// Genera chiave univoca per deduplicazione
function getArticoloKey(voce, tema, titolo = null) {
    const titoloDaUsare = titolo || tema;
    if (voce.tipo === "RED") {
        return `RED|${voce.firma}|${titoloDaUsare}`;
    } else if (voce.tipo === "RSS") {
        return `RSS|${titoloDaUsare}`;
    } else if (voce.tipo === "GEN") {
        return `GEN|${voce.firma}|${titoloDaUsare}`;
    }
    return null;
}

// Genera articoli RED casuali (Dalla Redazione)
function generaRedCasuali(CHI, vociAttive, LIMITI, oggi, articoliEsistenti) {
    const configRedRandom = LIMITI.articoli_random_red || {};
    if (!configRedRandom.abilitato) return [];
    
    const numMin = configRedRandom.num_min || 0;
    const numMax = configRedRandom.num_max || 0;
    
    if (numMax === 0) return [];
    
    let numDaGenerare = Math.floor(Math.random() * (numMax - numMin + 1)) + numMin;
    
    if (configRedRandom.solo_se_attivi) {
        const redAttiviOggi = vociAttive.filter(v => v.tipo === "RED").length;
        if (redAttiviOggi === 0) {
            log(`[FETCH] ⏭️ RED casuali: nessun RED attivo oggi, salto generazione`);
            return [];
        }
    }
    
    const personaggi = Object.keys(CHI).filter(n => n !== "default");
    if (personaggi.length === 0) return [];
    
    const temi = configRedRandom.temi || [
        "Riflessioni sulla vita", "Il piacere delle piccole cose", "Viaggi e scoperte",
        "Cibo e tradizioni", "Natura e sostenibilità", "Tecnologia e futuro",
        "Arte e creatività", "Sport e passione", "Musica e emozioni", "Libri e letture"
    ];
    
    const articoliRedCasuali = [];
    const sezioniDisponibili = [...new Set(vociAttive.map(v => v.sez))];
    const sezioneDefault = sezioniDisponibili[0] || "generale";
    
    for (let i = 0; i < numDaGenerare; i++) {
        const personaggio = personaggi[Math.floor(Math.random() * personaggi.length)];
        const tema = temi[Math.floor(Math.random() * temi.length)];
        const sezione = sezioniDisponibili[Math.floor(Math.random() * sezioniDisponibili.length)] || sezioneDefault;
        
        const voceRed = {
            g: "default",
            sez: sezione,
            tipo: "RED",
            lab: "Dalla Redazione",
            firma: personaggio,
            mood: "",
            num: 1,
            inventare: true,
            weight_articolo: 0.8,
            weight_commento: 0.7,
            temi: [tema],
            _parole: 400,
            _isRandom: true
        };
        
        const chiave = `RED|${personaggio}|${tema}`;
        if (!articoliEsistenti.has(chiave)) {
            articoliRedCasuali.push({ voce: voceRed, tema: tema });
            articoliEsistenti.add(chiave);
            log(`[FETCH] 🎲 RED casuale: ${personaggio} - "${tema}" (sez: ${sezione})`);
        }
    }
    
    return articoliRedCasuali;
}

// Test rapido provider con modello specifico
async function testProvider(provider, modelName = null) {
    const testSys = "Rispondi solo con 'ok' in JSON: {\"risposta\":\"ok\"}";
    const testPrompt = "Test";
    try {
        if (provider === "gemini" && modelName) {
            const result = await callLLM(testSys, testPrompt, 0.1);
            return result !== null;
        }
        const result = await callLLM(testSys, testPrompt, 0.1);
        return result !== null;
    } catch(e) {
        return false;
    }
}

// Funzione per ottenere i modelli Gemini disponibili (solo Flash testuali)
async function getGeminiModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return [];
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
        const data = await res.json();
        if (data.models) {
            const modelli = data.models
                .filter(m => {
                    const name = m.name;
                    return name.includes("gemini") && 
                           name.includes("flash") &&      
                           !name.includes("pro") &&
                           !name.includes("image") &&
                           !name.includes("tts") &&
                           m.supportedGenerationMethods?.includes("generateContent");
                })
                .map(m => m.name.replace("models/", ""))
                .sort((a, b) => b.localeCompare(a));
            return modelli;
        }
    } catch(e) {
        log(`[FETCH] ⚠️ Errore recupero modelli Gemini: ${e.message}`);
    }
    return [];
}

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // === ROTAZIONE LOG: se più vecchio di 2 giorni (48 ore) lo cancella e ricrea ===
    try {
        if (fs.existsSync(LOG_PATH)) {
            const stats = fs.statSync(LOG_PATH);
            const hoursOld = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
            if (hoursOld >= 48) {
                fs.unlinkSync(LOG_PATH);
                log(`🗑️ Log eliminato (più vecchio di 48 ore)`);
                fs.writeFileSync(LOG_PATH, '');
                log(`📄 Nuovo file log creato`);
            }
        } else {
            fs.writeFileSync(LOG_PATH, '');
            log(`📄 File log creato`);
        }
    } catch(e) { 
        // Ignora errori
    }

    // Reset opzionale del draft
    if (process.env.RESET_DRAFT === 'true') {
        if (fs.existsSync(DRAFT_PATH)) {
            fs.unlinkSync(DRAFT_PATH);
            log(`[FETCH] 🗑️ Draft cancellato su richiesta (RESET_DRAFT=true)`);
        }
        [TEMP_PATH, BACKUP_PATH].forEach(p => {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                log(`[FETCH] 🗑️ Cancellato anche ${path.basename(p)}`);
            }
        });
    }

    const isScheduled = process.env.SCHEDULED_RUN === "true";
    log(`[FETCH] 🏷️ Run ${isScheduled ? "SCHEDULATO (automatico)" : "MANUALE"}`);

    initConfig(CONFIG_PATH, log);
    initNews(process.env.GNEWS_API_KEY || "", process.env.NEWS_SOURCE || "gnews", log);
    initLLM(process.env.GEMINI_API_KEY || "", process.env.GROQ_API_KEY || "", PROVIDER_STATE_PATH, log);
    setScheduledRun(isScheduled);
    initDraft(log);
    initRelations(log);
    initChat(log);
    initArticoli(log);

    await initModels();

    const CONFIG = loadConfig();
    const { IMPOSTAZIONI, CHI, AGENDA, STILI, REDAZIONE, ICONE } = CONFIG;
    const LIMITI = CONFIG.LIMITI || {};

    let contatori = caricaContatori(CONTATORI_PATH, LIMITI, log);
    const articoliAttivi = fasciaDiArticoliAttiva(LIMITI);
    const parole = paroleTarget(LIMITI);
    log(`[FETCH] 📊 Quote: chiamate=${contatori.chiamate_gemini??0}, rss=${contatori.rss_fetch??0}`);
    log(`[FETCH] 🕐 Fascia attiva: ${articoliAttivi?"SÌ":"NO"} | Parole target: ~${parole}`);

    const oggi = giornoOggi();
    const agenda = risolviAgenda(AGENDA, oggi);
    const oraAggiornamento = new Date().toLocaleString("it-IT",{timeZone:"Europe/Rome", hour:"2-digit", minute:"2-digit", day:"2-digit", month:"2-digit"});

    let relazioni = caricaJSON(RELAZIONI_PATH, { _runCount:0 });
    let personaggi = caricaJSON(PERSONAGGI_PATH, {});
    for (const nome of Object.keys(CHI).filter(n=>n!=="default")) {
        if (!personaggi[nome]) personaggi[nome] = { stato:"normale", umore:"neutro", dal:null };
    }
    relazioni = applicaDecay(relazioni);

    const vociAttive = getVociAttive(oggi);
    log(`[FETCH] 📋 Voci attive: ${vociAttive.length}`);

    // Log delle voci RED (Dalla Redazione) attive oggi
    const vociRed = vociAttive.filter(v => v.tipo === "RED");
    if (vociRed.length > 0) {
        log(`[FETCH] \n📌 REDAZIONALI OGGI:`);
        for (const voce of vociRed) {
            const numTemi = voce.temi?.length || (voce.arg ? 1 : 0);
            log(`[FETCH]    ✍️ ${voce.firma} (${voce.sez}) – ${numTemi} temi`);
        }
    }

    const oggiStr = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome", day:"2-digit", month:"2-digit"});
    const draftEsistente = fs.existsSync(DRAFT_PATH) ? caricaJSON(DRAFT_PATH, null) : null;
    const isNuovoGiorno = !draftEsistente || draftEsistente.dataRiferimento !== oggiStr;

    // === DEDUPLICAZIONE: carica gli articoli già presenti oggi ===
    const articoliEsistenti = new Set();
    if (draftEsistente && !isNuovoGiorno) {
        for (const sez of Object.values(draftEsistente.sezioni || {})) {
            for (const art of (sez.articoli || [])) {
                let key = '';
                if (art.tipo === 'personaggio') {
                    key = `RED|${art.commento_firma?.nome || ''}|${art.titolo || ''}`;
                } else if (art.tipo === 'rss') {
                    key = `RSS|${art.titolo || ''}`;
                } else if (art.tipo === 'gen') {
                    key = `GEN|${art.commento_firma?.nome || ''}|${art.titolo || ''}`;
                }
                if (key) articoliEsistenti.add(key);
            }
        }
        if (articoliEsistenti.size > 0) {
            log(`[FETCH] 📋 Articoli già presenti oggi: ${articoliEsistenti.size}`);
        }
    }

    // Test provider con priorità a Gemini (Groq testato SOLO se Gemini fallisce)
    log(`[FETCH] 🔍 Verifica disponibilità provider...`);

    const modelloGiaTestato = getTestedGeminiModel();
    const FORCED_GEMINI_MODEL = process.env.FORCED_GEMINI_MODEL || "";
    // Qualsiasi modello testato è valido (a meno che non sia forzato)
    const isModelloValido = modelloGiaTestato && !FORCED_GEMINI_MODEL;

    let geminiOk = false;
    let geminiModelloFunzionante = null;
    let groqOk = false;

    if (isModelloValido) {
        log(`[FETCH] ✅ Modello Gemini già validato in initModels: ${modelloGiaTestato}`);
        geminiOk = true;
        geminiModelloFunzionante = modelloGiaTestato;
        log(`[FETCH] ⏭️ Test Groq saltato (Gemini già disponibile)`);
    } else {
        log(`[FETCH]    📡 Recupero modelli Gemini disponibili...`);
        let modelliGemini = await getGeminiModels();
        if (modelliGemini.length === 0) {
            log(`[FETCH]    ⚠️ Nessun modello Gemini trovato, uso lista di fallback`);
            modelliGemini = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"];
        }
        log(`[FETCH]    📋 Modelli Flash trovati: ${modelliGemini.slice(0, 5).join(", ")}${modelliGemini.length > 5 ? ` +${modelliGemini.length-5}` : ""}`);

        log(`[FETCH]    📡 Test Gemini...`);

        for (const model of modelliGemini.slice(0, 5)) {
            log(`[FETCH]       🔍 Test modello ${model}...`);
            const ok = await testProvider("gemini", model);
            if (ok) {
                geminiModelloFunzionante = model;
                setActiveGeminiModel(model);
                log(`[FETCH]       ✅ ${model} disponibile e impostato`);
                geminiOk = true;
                break;
            } else {
                log(`[FETCH]       ❌ ${model} non risponde`);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        
        // Test Groq SOLO SE Gemini non è disponibile
        if (!geminiOk) {
            log(`[FETCH]    📡 Test Groq...`);
            groqOk = await testProvider("groq");
            log(`[FETCH]    ${groqOk ? "✅ Groq disponibile" : "❌ Groq NON disponibile"}`);
        } else {
            log(`[FETCH]    ⏭️ Test Groq saltato (Gemini già disponibile)`);
        }
    }

    if (geminiOk) {
        log(`[FETCH]    ✅ Gemini disponibile (modello selezionato: ${geminiModelloFunzionante})`);
    } else if (groqOk) {
        log(`[FETCH]    ✅ Groq disponibile`);
    } else {
        log(`[FETCH]    ❌ NESSUN PROVIDER DISPONIBILE`);
    }

    if (!geminiOk && !groqOk) {
        log(`[FETCH] ❌ NESSUN PROVIDER DISPONIBILE (Gemini e Groq non rispondono)`);
        
        if (draftEsistente) {
            log(`[FETCH] 📁 Mantengo draft esistente del ${draftEsistente.dataRiferimento} (${contaArticoli(draftEsistente)} articoli)`);
            log(`[FETCH] ⏭️ Salto generazione articoli, la fase 2 elaborerà il draft esistente`);
            return;
        } else {
            log(`[FETCH] ⚠️ Nessun draft esistente – creo draft vuoto per evitare crash fase 2`);
            
            const draftVuoto = {
                dataRiferimento: oggiStr,
                oraAggiornamento: oraAggiornamento,
                agenda: agenda,
                impostazioni: IMPOSTAZIONI,
                stili: STILI,
                sezioni: {}
            };
            
            for (const voce of vociAttive) {
                const sez = voce.sez;
                if (!draftVuoto.sezioni[sez]) {
                    draftVuoto.sezioni[sez] = { color: STILI[sez] || STILI["RSS"] || "#005f73", articoli: [] };
                }
            }
            
            salvaJSON(DRAFT_PATH, draftVuoto);
            log(`[FETCH] 💾 Draft vuoto creato per il ${oggiStr}`);
            log(`[FETCH] ⏭️ La fase 2 avrà un file da elaborare (senza articoli)`);
            return;
        }
    }

    const providerScelto = geminiOk ? "Gemini" : "Groq";
    log(`[FETCH] 🎯 Provider scelto per questo run: ${providerScelto}${geminiOk ? ` (modello: ${geminiModelloFunzionante})` : ""}`);

    const { draft, oldDraft } = await caricaDraft(DRAFT_PATH, oggiStr, agenda, IMPOSTAZIONI, STILI);
    draft.oraAggiornamento = oraAggiornamento;
    inizializzaSezioni(draft, vociAttive, STILI);

    const articoliAbilitati = !limiteSuperato(contatori, LIMITI, "articoli_run_max");
    if (!articoliAbilitati) log(`[FETCH] ⏭️ Limite articoli_run raggiunto`);
    contatori.articoli_run = (contatori.articoli_run||0) + (articoliAbilitati?1:0);

    let codaArticoli = [];
    let articoliGenerati = 0;
    let articoliSaltatiPerDuplicato = 0;

    if (articoliAbilitati) {
        codaArticoli = await raccoltaNotizie(vociAttive, parole, contatori);
        
        // === GENERAZIONE ARTICOLI RED CASUALI ===
        const redCasuali = generaRedCasuali(CHI, vociAttive, LIMITI, oggi, articoliEsistenti);
        codaArticoli.push(...redCasuali);
        log(`[FETCH] 🎲 RED casuali da generare: ${redCasuali.length}`);
    }

    log(`[FETCH] 🔍 Deduplicazione: ${articoliEsistenti.size} articoli esistenti, ${codaArticoli.length} in coda`);

    const generatiSet = new Set();

    for (const { voce, tema, publishedAt } of codaArticoli) {
        const key = `${voce.sez}|${tema}`;
        if (generatiSet.has(key)) {
            log(`[FETCH] ⚠️ Duplicato evitato nella coda: ${tema.substring(0, 40)}...`);
            continue;
        }
        
        // Verifica se l'articolo è già stato pubblicato oggi (deduplicazione)
        const articoloKey = getArticoloKey(voce, tema);
        if (articoloKey && articoliEsistenti.has(articoloKey)) {
            log(`[FETCH] ⏭️ SKIP articolo già pubblicato oggi: ${voce.tipo} | ${voce.firma} | ${tema.substring(0, 40)}...`);
            articoliSaltatiPerDuplicato++;
            continue;
        }
        
        generatiSet.add(key);

        const sez = voce.sez;
        const infoFirma = risolviPersonaggio(CHI, voce.firma);
        const result = await generaArticolo(voce, CHI, tema, callLLM);
        if (!result) {
            log(`[FETCH] ⚠️ SKIP articolo per "${tema.substring(0, 40)}..." – nessun output valido da ${voce.firma}`);
            continue;
        }
        const { provider, titolo, articolo: articoloTesto, commento } = result;
        if (!articoloTesto || articoloTesto.length < 50) {
            log(`[FETCH] ⚠️ SKIP articolo per "${tema.substring(0, 40)}..." – testo troppo corto (${articoloTesto?.length || 0} caratteri) da ${voce.firma}`);
            continue;
        }
        const commenti = await generaCommenti(voce, CHI, relazioni, personaggi, articoloTesto, [], LIMITI, callLLM);
        if (commenti.length) {
            await aggiornaRelazioni(CHI, relazioni, personaggi, articoloTesto, commenti, callLLM);
        }
        
        let tipoOutput = voce.tipo === "RED" ? "personaggio" : (voce.tipo === "GEN" ? "gen" : "rss");
        let categoriaOutput = voce.tipo === "RED" ? "Dalla Redazione" : voce.lab;
        
        // Aggiungi la sigla della fonte e formatta la data
        let sourceSigla = "";
        if (voce.tipo === "RSS") {
            const currentNewsSource = process.env.NEWS_SOURCE || "gnews";
            sourceSigla = currentNewsSource === "gnews" ? "📰" : "📡";
        }
        
        let publishedAtStr = null;
        if (publishedAt) {
            publishedAtStr = formatDataArticolo(publishedAt, sourceSigla);
        } else if (sourceSigla) {
            publishedAtStr = `${sourceSigla} data sconosciuta`;
        }
        
        // Aggiungi anche la chiave basata sul titolo reale per future deduplicazioni
        const titoloKey = getArticoloKey(voce, tema, titolo);
        if (titoloKey) articoliEsistenti.add(titoloKey);
        
        draft.sezioni[sez].articoli.push({
            tipo: tipoOutput,
            titolo: titolo || tema,
            articolo: articoloTesto,
            commento_firma: { nome: voce.firma, avatar: infoFirma.avatar, testo: commento || "…" },
            commenti: commenti,
            categoria: categoriaOutput,
            colore_tipo: STILI[voce.tipo] || STILI["RSS"] || "#008cff",
            immagine: infoFirma.img || "default_personaggio.webp",
            provider: provider,
            publishedAt: publishedAtStr
        });
        articoliGenerati++;
        
        if (voce.tipo === "RED") {
            log(`[FETCH] ✍️ [Dalla Redazione] ${voce.firma} (${provider}): "${(titolo||tema).substring(0, 50)}..." – ${articoloTesto.length} caratteri`);
        } else {
            log(`[FETCH] ✅ ${voce.firma} (${provider}): "${(titolo||tema).substring(0, 50)}..." – ${articoloTesto.length} caratteri, ${commenti.length} commenti`);
            if (publishedAtStr) {
                log(`[FETCH]    📅 ${publishedAtStr}`);
            }
        }
    }

    if (articoliSaltatiPerDuplicato > 0) {
        log(`[FETCH] ⏭️ Saltati per duplicato: ${articoliSaltatiPerDuplicato}`);
    }

    const chatAbilitata = LIMITI.chat!=="sempre" ? !limiteSuperato(contatori, LIMITI, "chat_run_max") : true;
    const chattaOggi = chatAbilitata && Math.random()<0.30;
    if (chattaOggi) contatori.chat_run = (contatori.chat_run||0)+1;
    const chat = chattaOggi ? await generaChat(CHI, relazioni, personaggi, callLLM) : null;
    if (chat) {
        const storico = caricaJSON(CHAT_PATH, []);
        storico.unshift({ data: oraAggiornamento, messaggi: chat });
        if (storico.length>30) storico.splice(30);
        salvaJSON(CHAT_PATH, storico);
        log(`[FETCH] 💬 Chat salvata (${chat.length} messaggi)`);
    }

    contatori.chiamate_gemini_totali = (contatori.chiamate_gemini_totali||0) + (globalThis._chiamateApi || 0);
    contatori.token_stimati_totali = (contatori.token_stimati_totali||0) + ((globalThis._chiamateApi||0) * 450);
    salvaJSON(CONTATORI_PATH, contatori);
    salvaJSON(RELAZIONI_PATH, relazioni);
    salvaJSON(PERSONAGGI_PATH, personaggi);

    const currentProvider = getCurrentProvider();
    if (currentProvider === "gemini") {
        if (articoliGenerati > 0) {
            resetConsecutiveFailures();
        } else {
            incrementConsecutiveFailures();
        }
    }

    // Se nessun articolo è stato generato, mantieni il draft esistente
    if (articoliGenerati === 0) {
        log(`[FETCH] ⚠️ Nessun articolo generato in questo run.`);
        if (draftEsistente && isNuovoGiorno) {
            log(`[FETCH] 📁 Nuovo giorno ma nessun articolo – mantengo draft del ${draftEsistente.dataRiferimento} (${contaArticoli(draftEsistente)} articoli)`);
        } else if (draftEsistente && !isNuovoGiorno) {
            log(`[FETCH] 📁 Stesso giorno – mantengo draft esistente (${contaArticoli(draftEsistente)} articoli)`);
        } else {
            log(`[FETCH] ⚠️ Nessun draft esistente e nessun articolo generato – impossibile salvare`);
        }
        return;
    }

    const ok = await safeWriteDraft(draft, DRAFT_PATH, TEMP_PATH, BACKUP_PATH);
    if (ok) {
        contatori._primoRunOggi = true;
        salvaJSON(CONTATORI_PATH, contatori);
        log(`[FETCH] ✅ FASE 1-v4 completata. ${articoliGenerati} nuovi articoli.`);
    } else {
        log(`[FETCH] ⚠️ Salvataggio draft fallito.`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });