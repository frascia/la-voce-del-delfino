#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino (Versione Definitiva GitHub Actions - Corretta)
 * Caratteristiche:
 * - Auto-Discovery del modello per evitare errori 404
 * - Gestione avanzata Rate Limit (429) con Retry intelligente e pause per IP condivisi
 * - Prompt SVG ottimizzati per evitare i blocchi di sicurezza (Safety Filters)
 * - Parser JSON antiproiettile
 * - Corretto schema JSON per la satira e prompt SVG per garantire la generazione delle immagini
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Configurazione percorsi
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Controllo Chiave API
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { 
  console.error("❌ GEMINI_API_KEY mancante. Inseriscila nel tuo ambiente o nei Secrets di GitHub"); 
  process.exit(1); 
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today    = new Date().toLocaleDateString("it-IT", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});

// Variabili globali di stato
let WORKING_MODEL = null;
let callCount = 0;

// ─────────────────────────────────────────────
//  Step 0: Trova automaticamente il modello valido
// ─────────────────────────────────────────────
async function autoDiscoverModel() {
  console.log("🔍 Interrogo Google per trovare i modelli disponibili...");
  const res = await fetch(`${BASE_URL}/models?key=${API_KEY}`);
  if (!res.ok) throw new Error(`Impossibile recuperare la lista dei modelli. Controlla la tua API Key.`);

  const data = await res.json();
  
  // Filtra solo i modelli Flash che supportano la generazione di testo
  const flashModels = data.models.filter(m => 
    m.supportedGenerationMethods?.includes("generateContent") && 
    m.name.includes("flash")
  );

  if (flashModels.length === 0) throw new Error("Nessun modello 'Flash' abilitato trovato.");

  // Prendi il 2.5 se esiste, altrimenti il 2.0, altrimenti il primo disponibile
  const bestModel = 
    flashModels.find(m => m.name.includes("2.5")) || 
    flashModels.find(m => m.name.includes("2.0")) || 
    flashModels[0];

  console.log(`✅ Modello compatibile agganciato: ${bestModel.name}`);
  WORKING_MODEL = bestModel.name; 
}

// ─────────────────────────────────────────────
//  Il Motore API con Gestione Limiti Estrema (GitHub Actions safe)
// ─────────────────────────────────────────────
async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096, isJson = false, retries = 0 }) {
  // Pausa lunga ogni 10 chiamate
  if (callCount > 0 && callCount % 10 === 0) {
    console.log(`\n ⏸️  Traffico intenso. Il Delfino prende fiato per 60 secondi...`);
    await new Promise(r => setTimeout(r, 60_000));
  }

  callCount++;
  console.log(`  [Chiamata #${callCount}]`);

  const body = {
    contents: [{ role:"user", parts:[{ text:prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 1.0 }
  };
  
  // Non forzare il mime_type json se usi la ricerca Google (evita errore 400)
  if (isJson && !useSearch) {
      body.generationConfig.response_mime_type = "application/json";
  }
  
  if (system) body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  const url = `${BASE_URL}/${WORKING_MODEL}:generateContent?key=${API_KEY}`;
  
  const res = await fetch(url, { 
      method:"POST", 
      headers:{"Content-Type":"application/json"}, 
      body:JSON.stringify(body) 
  });

  if (!res.ok) {
    const errText = await res.text();
    
    // Gestione intelligente del Rate Limit (429)
    if (res.status === 429) {
        console.log(`\n⚠️ 429 Rilevato! Motivo: ${errText.slice(0, 150)}`);
        
        // Se hai finito i crediti gratuiti, fermiamo tutto per non sprecare minuti GitHub
        if (errText.toLowerCase().includes("quota")) {
            throw new Error("QUOTA GIORNALIERA ESAURITA! Google ha chiuso i rubinetti per oggi.");
        }
        
        // Se è solo traffico, riproviamo massimo 3 volte
        if (retries >= 3) {
            throw new Error("Troppi tentativi falliti per limite di traffico. Mi arrendo per questa sezione.");
        }
        
        console.log(`⏳ GitHub IP lento. Ritento tra 60 secondi... (Tentativo ${retries + 1} di 3)`);
        await new Promise(r => setTimeout(r, 60_000)); // Pausa molto lunga per resettare l'IP
        return callGemini({ system, prompt, useSearch, maxTokens, isJson, retries: retries + 1 });
    }
    
    throw new Error(`API HTTP ${res.status}: ${errText.slice(0,150)}`);
  }

  const data = await res.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  // PAUSA LUNGA OBBLIGATORIA DOPO OGNI CHIAMATA (FONDAMENTALE SU GITHUB ACTIONS)
  await new Promise(r => setTimeout(r, 10_000)); 
  
  return textResponse;
}

// ─────────────────────────────────────────────
//  Helper per parse JSON sicuro a prova di Markdown
// ─────────────────────────────────────────────
function parseNews(text) {
    try {
        const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.error("❌ Errore parsing JSON. Frammento:", text.slice(0, 100));
        return []; 
    }
}

// ─────────────────────────────────────────────
//  Costruzione delle Sezioni (Versione Corretta)
// ─────────────────────────────────────────────
async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";

  // Ho aumentato il numero di articoli a 12
  const NUM_ARTICOLI = 12;

  console.log(`\n${label} — Ricerca e Scrittura Notizie...`);
  const rawJson = await callGemini({
    system: `Sei un redattore pungente. Rispondi SOLO con un array JSON puro. NESSUN TESTO PRIMA O DOPO, ZERO BACKTICK.
    Chiavi: titolo, categoria, sommario, commento, fonte, luogo.`,
    prompt: isPescara
      ? `Cerca ${NUM_ARTICOLI} notizie VERE di oggi (${today}) su Pescara/Abruzzo. Temi vari (sport, cronaca bianca, eventi). Array JSON.`
      : `Oggi è ${today}. Cerca ${NUM_ARTICOLI} notizie VERE dal mondo. Temi vari (scienza, tech, curiosità). Array JSON.`,
    useSearch: true,
    maxTokens: 4000
  });

  let allNews = parseNews(rawJson).map(n => ({ ...n, isFake: false, svg: null }));

  console.log(`${label} — Aggiungo la Satira...`);
  const satiraRaw = await callGemini({
    // FIX SATIRA: Schema JSON forzato per garantire la compatibilità delle chiavi
    system: `Inventa una notizia satirica falsa e assurda. Rispondi SOLO in un oggetto JSON puro.
    DEVI USARE ESATTAMENTE QUESTE CHIAVI: "titolo", "categoria", "sommario", "commento", "fonte", "luogo".`,
    prompt: isPescara ? "Satira su Pescara (es. arrosticini, mare, traffico). Fonte: 'Il Delfino Sognatore'" : "Satira tecnologica o politica internazionale assurda. Fonte: 'Il Delfino Sognatore'",
    maxTokens: 2000,
    isJson: true 
  });
  
  const satiraObj = parseNews(satiraRaw);
  const finalSatira = Array.isArray(satiraObj) ? satiraObj[0] : satiraObj;
  if(finalSatira && finalSatira.titolo) allNews.push({ ...finalSatira, isFake: true, svg: null });

  console.log(`${label} — Generazione Illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    try {
        const svgCode = await callGemini({
            // FIX IMMAGINI: Prompt blindato per garantire output SVG crudo e valido
            system: `Sei un generatore automatico di codice SVG. Devi restituire ESCLUSIVAMENTE il codice <svg> crudo. Niente markdown, niente chiacchiere, niente backtick.`,
            prompt: `Genera un <svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg">. 
            Stile: Astratto, geometrico, minimalista (massimo 8 forme). Colori pastello eleganti. 
            Deve rappresentare visivamente questa frase: "${item.titolo}". 
            Non inserire testo nell'immagine, solo forme (rect, circle, path). Assicurati di chiudere il tag </svg>.`,
            maxTokens: 2000 
        });
        
        // Estrazione aggressiva del tag SVG
        const match = svgCode.match(/<svg[\s\S]*?<\/svg>/i);
        if (match) {
            item.svg = match[0];
            process.stdout.write("✓ ");
        } else {
            process.stdout.write("✗(no-tag) ");
        }
    } catch (e) {
        const errMsg = e.message.toLowerCase();
        const reason = errMsg.includes("safety") ? "Sicurezza" : "Timeout";
        process.stdout.write(`!(${reason}) `);
    }
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

// ─────────────────────────────────────────────
//  Avvio della Pipeline
// ─────────────────────────────────────────────
async function main() {
  console.log("🐬 La Voce del Delfino — Avvio di Produzione");
  
  try {
    await autoDiscoverModel();
  } catch (error) {
    console.error("❌ Impossibile avviare il sistema:", error.message);
    process.exit(1);
  }

  for (const isPescara of [false, true]) {
    try {
      const data = await buildSection(isPescara);
      const fname = isPescara ? "news-pescara.json" : "news-mondo.json";
      fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(data, null, 2));
      console.log(`\n✅ Salvato ${fname}`);
    } catch(e) {
      console.error(`\n❌ Errore fatale su ${isPescara?"Pescara":"Mondo"}: ${e.message}`);
    }
  }
  console.log("\n🎉 Finito! Il notiziario è pronto.");
}

// Esecuzione
main();
