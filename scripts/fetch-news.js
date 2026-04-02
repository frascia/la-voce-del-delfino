#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino (Anti-Troncamento & Rate Limit Sicuro)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { 
  console.error("❌ GEMINI_API_KEY mancante. Inseriscila nel tuo ambiente o nel file .env"); 
  process.exit(1); 
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today    = new Date().toLocaleDateString("it-IT", {
  weekday:"long", year:"numeric", month:"long", day:"numeric"
});

let WORKING_MODEL = null;
let callCount = 0;

// ─────────────────────────────────────────────
//  Step 0: Trova automaticamente il modello valido
// ─────────────────────────────────────────────
async function autoDiscoverModel() {
  console.log("🔍 Interrogo Google per trovare i modelli disponibili...");
  const res = await fetch(`${BASE_URL}/models?key=${API_KEY}`);
  if (!res.ok) throw new Error(`Impossibile recuperare la lista dei modelli.`);

  const data = await res.json();
  const flashModels = data.models.filter(m => 
    m.supportedGenerationMethods?.includes("generateContent") && 
    m.name.includes("flash")
  );

  if (flashModels.length === 0) throw new Error("Nessun modello 'Flash' abilitato trovato.");

  const bestModel = flashModels.find(m => m.name.includes("2.5")) || flashModels[0];
  console.log(`✅ Modello compatibile agganciato: ${bestModel.name}`);
  WORKING_MODEL = bestModel.name; 
}

// ─────────────────────────────────────────────
//  Il Motore API con Gestione Limiti e JSON Forzato
// ─────────────────────────────────────────────
async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096, isJson = false }) {
  // Pausa lunga ogni 10 chiamate per resettare le quote di Google
  if (callCount > 0 && callCount % 10 === 0) {
    console.log(`\n ⏸️  Pausa strategica di 60s per raffreddare i server...`);
    await new Promise(r => setTimeout(r, 60_000));
  }

  callCount++;
  console.log(`  [Chiamata #${callCount}]`);

  const body = {
    contents: [{ role:"user", parts:[{ text:prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 1.0 }
  };
  
  if (isJson && !useSearch) body.generationConfig.response_mime_type = "application/json";
  if (system) body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  const url = `${BASE_URL}/${WORKING_MODEL}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
        console.log("⚠️ 429 Troppe richieste. Il Delfino attende 30 secondi...");
        await new Promise(r => setTimeout(r, 30_000));
        return callGemini({ system, prompt, useSearch, maxTokens, isJson }); // Ritenta
    }
    throw new Error(`API HTTP ${res.status}: ${errText.slice(0,150)}`);
  }

  const data = await res.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  // PAUSA FONDAMENTALE DI 3 SECONDI DOPO OGNI CHIAMATA (Evita il burst 429)
  await new Promise(r => setTimeout(r, 3000));
  
  return textResponse;
}

// ─────────────────────────────────────────────
//  Helper per parse JSON sicuro
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
//  Costruzione delle Sezioni
// ─────────────────────────────────────────────
async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";

  console.log(`\n${label} — Ricerca e Scrittura Notizie...`);
  const rawJson = await callGemini({
    system: `Sei un redattore pungente. Rispondi SOLO con un array JSON puro. ZERO BACKTICK.
    Chiavi: titolo, categoria, sommario, commento, fonte, luogo.`,
    prompt: isPescara
      ? `Cerca 8 notizie VERE di oggi (${today}) su Pescara/Abruzzo. Temi vari. Array JSON.`
      : `Oggi è ${today}. Cerca 8 notizie VERE dal mondo. Temi vari. Array JSON.`,
    useSearch: true,
    maxTokens: 4000
  });

  let allNews = parseNews(rawJson).map(n => ({ ...n, isFake: false, svg: null }));

  console.log(`${label} — Aggiungo la Satira...`);
  const satiraRaw = await callGemini({
    system: "Inventa una notizia satirica falsa. Rispondi SOLO in JSON.",
    prompt: isPescara ? "Satira su Pescara" : "Satira tecnologica/politica",
    maxTokens: 2000, // Aumentato da 600 a 2000 per evitare il troncamento!
    isJson: true
  });
  
  const satiraObj = parseNews(satiraRaw);
  const finalSatira = Array.isArray(satiraObj) ? satiraObj[0] : satiraObj;
  if(finalSatira && finalSatira.titolo) allNews.push({ ...finalSatira, isFake: true, svg: null });

  console.log(`${label} — Generazione Illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    try {
        // Prompt sistemato per far capire che vogliamo CODICE TESTUALE, non un file immagine
        const svgCode = await callGemini({
            system: "Sei uno sviluppatore frontend esperto in grafica vettoriale. Scrivi SOLO il CODICE SORGENTE TESTUALE XML per un tag <svg>. Non sei un generatore di immagini, devi solo restituire testo formattato come XML. Zero spiegazioni, zero markdown.",
            prompt: `Scrivi il codice <svg> minimalista a colori pastello per rappresentare questa scena: "${item.titolo}". ViewBox="0 0 900 400".`,
            maxTokens: 1500
        });
        item.svg = svgCode.match(/<svg[\s\S]*?<\/svg>/i)?.[0] || null;
        process.stdout.write(item.svg ? "✓ " : "✗ ");
    } catch (e) {
        process.stdout.write("! ");
    }
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

// ─────────────────────────────────────────────
//  Avvio
// ─────────────────────────────────────────────
async function main() {
  console.log("🐬 La Voce del Delfino — Avvio di Produzione");
  
  try {
    await autoDiscoverModel();
  } catch (error) {
    console.error("❌ Impossibile avviare:", error.message);
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

main();
