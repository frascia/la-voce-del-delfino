#!/usr/bin/env node
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
import { initLLM, callLLM, initModels } from "./lib/llm.js";
import { initDraft, caricaDraft, inizializzaSezioni, safeWriteDraft } from "./lib/draft.js";
import { initRelations, applicaDecay, aggiornaRelazioni } from "./lib/relations.js";
import { initChat, generaChat } from "./lib/chat.js";
import { initArticoli, generaArticolo, generaCommenti } from "./lib/articoli.js";

function log(msg) { scriviLog(msg, LOG_PATH); }

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    
    // Inizializza tutti i moduli con la stessa funzione di log
    initConfig(CONFIG_PATH, log);
    initNews(process.env.GNEWS_API_KEY || "", process.env.NEWS_SOURCE || "gnews", log);
    initLLM(process.env.GEMINI_API_KEY || "", process.env.GROQ_API_KEY || "", PROVIDER_STATE_PATH, log);
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
    
    for (const { voce, tema } of codaArticoli) {
        const sez = voce.sez;
        const infoFirma = risolviPersonaggio(CHI, voce.firma);
        const parsed = await generaArticolo(voce, CHI, tema, callLLM);
        if (!parsed?.articolo || parsed.articolo.length < 50) {
            log(`⚠️ SKIP articolo su "${tema.substring(0,30)}..."`);
            continue;
        }
        const commenti = await generaCommenti(voce, CHI, relazioni, personaggi, parsed.articolo, [], LIMITI, callLLM);
        if (commenti.length) {
            await aggiornaRelazioni(CHI, relazioni, personaggi, parsed.articolo, commenti, callLLM);
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
        log(`  ✅ "${(parsed.titolo||tema).substring(0,50)}..." (${commenti.length} commenti)`);
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
    
    const nomiPers = Object.keys(CHI).filter(n=>n!=="default");
    if (nomiPers.length) {
        const pers = nomiPers[Math.floor(Math.random()*nomiPers.length)];
        const dati = CHI[pers];
        const sysPers = `Sei ${pers} (${dati.mood}). ${dati.bio_breve?`Bio: "${dati.bio_breve}"` : ""}
Scrivi breve articolo (150-250 parole) su un argomento personale.
Rispondi JSON: {"titolo":"...","articolo":"..."}`;
        const { text: rawPers } = await callLLM(sysPers, "Scrivi articolo personale.", dati.peso??0.8);
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
            log(`✍️ Articolo personaggio da ${pers}: "${parsedPers.titolo.substring(0,50)}..."`);
        }
    }
    
    if (articoliGenerati === 0) {
        log("⚠️ Nessun articolo generato. Draft non modificato.");
        if (isNuovoGiorno && oldDraft) log(`   → Mantenuto draft del ${oldDraft.dataRiferimento}`);
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
