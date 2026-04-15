#!/usr/bin/env node
/**
 * FILE: 1-fetch-v4.js
 * DATA: 2025-04-15
 * VERSIONE: 4.5
 * DESCRIZIONE: Orchestratore principale per la generazione degli articoli.
 *              Supporta Gemini e Groq, fallback persistente, reset opzionale.
 *              Tipi supportati: RSS, GEN, RED (Dalla Redazione).
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
         caricaContatori, limiteSuperato, fasciaDiArticoliAttiva, paroleTarget } from "./lib/utils.js";
import { initConfig, loadConfig, getVociAttive } from "./lib/config.js";
import { initNews, raccoltaNotizie } from "./lib/news.js";
import { initLLM, callLLM, initModels, setScheduledRun, incrementConsecutiveFailures, resetConsecutiveFailures, getCurrentProvider } from "./lib/llm.js";
import { initDraft, caricaDraft, inizializzaSezioni, safeWriteDraft } from "./lib/draft.js";
import { initRelations, applicaDecay, aggiornaRelazioni } from "./lib/relations.js";
import { initChat, generaChat } from "./lib/chat.js";
import { initArticoli, generaArticolo, generaCommenti } from "./lib/articoli.js";

function log(msg) { scriviLog(msg, LOG_PATH); }

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Reset opzionale del draft
    if (process.env.RESET_DRAFT === 'true') {
        if (fs.existsSync(DRAFT_PATH)) {
            fs.unlinkSync(DRAFT_PATH);
            log(`🗑️ Draft cancellato su richiesta (RESET_DRAFT=true)`);
        }
        [TEMP_PATH, BACKUP_PATH].forEach(p => {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                log(`🗑️ Cancellato anche ${path.basename(p)}`);
            }
        });
    }

    const isScheduled = process.env.SCHEDULED_RUN === "true";
    log(`🏷️ Run ${isScheduled ? "SCHEDULATO (automatico)" : "MANUALE"}`);

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
    log(`📊 Quote: chiamate=${contatori.chiamate_gemini??0}, rss=${contatori.rss_fetch??0}`);
    log(`🕐 Fascia attiva: ${articoliAttivi?"SÌ":"NO"} | Parole target: ~${parole}`);

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
    log(`📋 Voci attive: ${vociAttive.length}`);

    // Log delle voci RED (Dalla Redazione) attive oggi
    const vociRed = vociAttive.filter(v => v.tipo === "RED");
    if (vociRed.length > 0) {
        log(`\n📌 REDAZIONALI OGGI:`);
        for (const voce of vociRed) {
            const numTemi = voce.temi?.length || (voce.arg ? 1 : 0);
            log(`   ✍️ ${voce.firma} (${voce.sez}) – ${numTemi} temi`);
        }
    }

    const oggiStr = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome", day:"2-digit", month:"2-digit"});
    const { draft, isNuovoGiorno, oldDraft } = await caricaDraft(DRAFT_PATH, oggiStr, agenda, IMPOSTAZIONI, STILI);
    draft.oraAggiornamento = oraAggiornamento;
    inizializzaSezioni(draft, vociAttive, STILI);

    const articoliAbilitati = !limiteSuperato(contatori, LIMITI, "articoli_run_max");
    if (!articoliAbilitati) log("⏭️ Limite articoli_run raggiunto");
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
            log(`⚠️ Duplicato evitato: ${tema}`);
            continue;
        }
        generatiSet.add(key);

        const sez = voce.sez;
        const infoFirma = risolviPersonaggio(CHI, voce.firma);
        const result = await generaArticolo(voce, CHI, tema, callLLM);
        if (!result) {
            log(`⚠️ SKIP articolo per "${tema.substring(0, 40)}..." (nessun output valido)`);
            continue;
        }
        const { provider, titolo, articolo: articoloTesto, commento } = result;
        if (!articoloTesto || articoloTesto.length < 50) {
            log(`⚠️ SKIP articolo su "${tema.substring(0, 40)}..." (testo troppo corto)`);
            continue;
        }
        const commenti = await generaCommenti(voce, CHI, relazioni, personaggi, articoloTesto, [], LIMITI, callLLM);
        if (commenti.length) {
            await aggiornaRelazioni(CHI, relazioni, personaggi, articoloTesto, commenti, callLLM);
        }
        
        // Determina il tipo per il frontend
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
        
        // Log differenziato per tipo
        if (voce.tipo === "RED") {
            log(`✍️ [Dalla Redazione] ${voce.firma} (${provider}): "${(titolo||tema).substring(0, 50)}..." (${articoloTesto.length} parole)`);
        } else {
            log(`✓ ${voce.firma} (${provider}): "${(titolo||tema).substring(0, 50)}..." (${commenti.length} commenti)`);
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
        log(`💬 Chat salvata (${chat.length} messaggi)`);
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

    // Se nessun articolo è stato generato, crea comunque un draft vuoto
    if (articoliGenerati === 0) {
        log("⚠️ Nessun articolo generato. Creo un draft vuoto per non interrompere la catena.");
        
        if (!draft.sezioni || Object.keys(draft.sezioni).length === 0) {
            for (const voce of vociAttive) {
                const sez = voce.sez;
                if (!draft.sezioni[sez]) {
                    draft.sezioni[sez] = { color: STILI[sez] || STILI["RSS"] || "#005f73", articoli: [] };
                }
            }
        }
        
        try {
            salvaJSON(DRAFT_PATH, draft);
            log(`💾 Draft vuoto salvato in ${DRAFT_PATH} (nessun articolo, ma la catena continua)`);
        } catch(e) {
            log(`❌ Errore salvataggio draft vuoto: ${e.message}`);
        }
        
        contatori._primoRunOggi = true;
        salvaJSON(CONTATORI_PATH, contatori);
        log("✅ FASE 1-v4 completata (nessun articolo, ma draft vuoto creato).");
        return;
    }

    const ok = await safeWriteDraft(draft, DRAFT_PATH, TEMP_PATH, BACKUP_PATH);
    if (ok) {
        contatori._primoRunOggi = true;
        salvaJSON(CONTATORI_PATH, contatori);
        log(`✅ FASE 1-v4 completata. ${articoliGenerati} nuovi articoli.`);
    } else {
        log("⚠️ Salvataggio draft fallito.");
    }
}

main().catch(err => { console.error(err); process.exit(1); });
