#!/usr/bin/env node
/**
 * FILE: 1-fetch-v4.js
 * DATA: 2025-04-15
 * VERSIONE: 4.12
 * DESCRIZIONE: Orchestratore principale per la generazione degli articoli.
 *              Supporta Gemini e Groq, fallback persistente, reset opzionale.
 *              Tipi supportati: RSS, GEN, RED (Dalla Redazione).
 *              Log con prefisso [FETCH] per chiarezza.
 *              Recupero dinamico dei modelli Gemini Flash (esclude Pro, image, tts).
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
import { initLLM, callLLM, initModels, setScheduledRun, incrementConsecutiveFailures, resetConsecutiveFailures, getCurrentProvider, setActiveGeminiModel } from "./lib/llm.js";
import { initDraft, caricaDraft, inizializzaSezioni, safeWriteDraft } from "./lib/draft.js";
import { initRelations, applicaDecay, aggiornaRelazioni } from "./lib/relations.js";
import { initChat, generaChat } from "./lib/chat.js";
import { initArticoli, generaArticolo, generaCommenti } from "./lib/articoli.js";

function log(msg) { scriviLog(msg, LOG_PATH); }

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
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        if (data.models) {
            // Filtra solo modelli Flash testuali
            const modelli = data.models
                .filter(m => {
                    const name = m.name;
                    return name.includes("gemini") && 
                           name.includes("flash") &&      
                           !name.includes("pro") &&
                           !name.includes("image") &&     // escludi modelli per immagini
                           !name.includes("tts") &&       // escludi text-to-speech
                           m.supportedGenerationMethods?.includes("generateContent");
                })
                .map(m => m.name.replace("models/", ""))
                .sort((a, b) => b.localeCompare(a)); // ordine decrescente (più recente prima)
            return modelli;
        }
    } catch(e) {
        log(`[FETCH] ⚠️ Errore recupero modelli Gemini: ${e.message}`);
    }
    return [];
}

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

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

    // Test provider con visualizzazione modelli
    log(`[FETCH] 🔍 Verifica disponibilità provider...`);

    log(`[FETCH]    📡 Recupero modelli Gemini disponibili...`);
    let modelliGemini = await getGeminiModels();
    if (modelliGemini.length === 0) {
        log(`[FETCH]    ⚠️ Nessun modello Flash trovato, uso lista di fallback`);
        modelliGemini = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"];
    }
    log(`[FETCH]    📋 Modelli Flash trovati: ${modelliGemini.join(", ")}`);

    log(`[FETCH]    📡 Test Gemini...`);
    let geminiModelloFunzionante = null;

    for (const model of modelliGemini) {
        log(`[FETCH]       🔍 Test modello ${model}...`);
        const ok = await testProvider("gemini", model);
        if (ok) {
            geminiModelloFunzionante = model;
            setActiveGeminiModel(model);
            log(`[FETCH]       ✅ ${model} disponibile e impostato`);
            break;
        } else {
            log(`[FETCH]       ❌ ${model} non risponde`);
        }
    }

    const geminiOk = geminiModelloFunzionante !== null;
    if (geminiOk) {
        log(`[FETCH]    ✅ Gemini disponibile (modello selezionato: ${geminiModelloFunzionante})`);
    } else {
        log(`[FETCH]    ❌ Gemini NON disponibile (nessun modello Flash risponde)`);
    }

    log(`[FETCH]    📡 Test Groq...`);
    const groqOk = await testProvider("groq");
    log(`[FETCH]    ${groqOk ? "✅ Groq disponibile" : "❌ Groq NON disponibile"}`);

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
    if (articoliAbilitati) {
        codaArticoli = await raccoltaNotizie(vociAttive, parole, contatori);
    }

    const generatiSet = new Set();

    for (const { voce, tema } of codaArticoli) {
        const key = `${voce.sez}|${tema}`;
        if (generatiSet.has(key)) {
            log(`[FETCH] ⚠️ Duplicato evitato: ${tema}`);
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
        
        draft.sezioni[sez].articoli.push({
            tipo: tipoOutput,
            titolo: titolo || tema,
            articolo: articoloTesto,
            commento_firma: { nome: voce.firma, avatar: infoFirma.avatar, testo: commento || "…" },
            commenti: commenti,
            categoria: categoriaOutput,
            colore_tipo: STILI[voce.tipo] || STILI["RSS"] || "#008cff",
            immagine: infoFirma.img || "default_personaggio.webp",
            provider: provider
        });
        articoliGenerati++;
        
        if (voce.tipo === "RED") {
            log(`[FETCH] ✍️ [Dalla Redazione] ${voce.firma} (${provider}): "${(titolo||tema).substring(0, 50)}..." – ${articoloTesto.length} caratteri`);
        } else {
            log(`[FETCH] ✅ ${voce.firma} (${provider}): "${(titolo||tema).substring(0, 50)}..." – ${articoloTesto.length} caratteri, ${commenti.length} commenti`);
        }
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

    // Se nessun articolo è stato generato, mantieni il draft esistente (non sovrascrivere)
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

    // Salvataggio normale con safeWriteDraft (draft non vuoto)
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
