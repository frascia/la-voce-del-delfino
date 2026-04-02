#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino (Versione Definitiva Auto-Discovery)
 * Risolve automaticamente gli errori 404 trovando il modello corretto per la tua API Key.
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

// Variabile globale per salvare il modello trovato dinamicamente
let WORKING_MODEL = null;
let callCount = 0;

// ─────────────────────────────────────────────
//  Step 0: Trova automaticamente il modello valido
// ─────────────────────────────────────────────
async function autoDiscoverModel() {
  console.log("🔍 Interrogo Google per trovare i modelli disponibili...");
  const res = await fetch(`${BASE_URL}/models?key=${API_KEY}`);
  
  if (!res.ok) {
    throw new Error(`Impossibile recuperare la lista dei modelli. Controlla la tua API Key.`);
  }

  const data = await res.json();
  
  // Cerchiamo un modello che supporti la generazione di contenuti e che sia della famiglia "flash"
  const flashModels = data.models.filter(m => 
    m.supportedGenerationMethods?.includes("generateContent") && 
    m.name.includes("flash")
  );

  if (flashModels.length === 0) {
    throw new Error("Nessun modello 'Flash' abilitato trovato per questa API Key.");
  }

  // Ordiniamo per provare a prendere i più recenti (2.5, poi 2.0, poi 1.5)
  const bestModel = 
    flashModels.find(m => m.name.includes("2.5")) || 
    flashModels.find(m => m.name.includes("2.0")) || 
    flashModels[0];

  console.log(`✅ Modello compatibile agganciato: ${bestModel.name}`);
  
  // Il campo .name di Google include già "models/" (es. "models/gemini-2.0-flash")
  WORKING_MODEL = bestModel.name; 
}

// ─────────────────────────────────────────────
//  Il Motore API con Gestione Limiti e JSON Forzato
// ─────────────────────────────────────────────
async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096, isJson = false }) {
  // Pausa strategica ogni 10 chiamate per il Free Tier
  if (callCount > 0 && callCount % 10 === 0) {
    console.log(`\n ⏸️  Traffico intenso (${callCount} chiamate). Il Delfino prende fiato per 65 secondi...`);
    await new Promise(r => setTimeout(r, 65_000));
  }

  callCount++;
  console.log(`  [Chiamata #${callCount}]`);

  const body = {
    contents: [{ role:"user", parts:[{ text:prompt }] }],
    generationConfig: { 
      maxOutputTokens: maxTokens, 
      temperature: 1.0 
    }
  };
  
  if (isJson) body.generationConfig.response_mime_type = "application/json";
  if (system) body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  // Usiamo il modello trovato dinamicamente!
  const url = `${BASE_URL}/${WORKING_MODEL}:generateContent?key=${API_KEY}`;

  const res = await fetch(url, { 
    method:"POST", 
    headers:{"Content-Type":"application/json"}, 
    body:JSON.stringify(body) 
  });

  if (!res.ok) {
    const errText = await res.text();
    // Gestione automatica dell'errore 429 (Troppe richieste)
    if (res.status === 429) {
        console.log("⚠️ Troppe richieste (429). Ritento automaticamente tra 30 secondi...");
        await new Promise(r => setTimeout(r, 30_000));
        return callGemini({ system, prompt, useSearch, maxTokens, isJson });
    }
    throw new Error(`API HTTP ${res.status}: ${errText.slice(0,150)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Helper per parse JSON sicuro
function parseNews(text) {
    try {
        return JSON.parse(text.trim());
    } catch (e) {
        console.error("❌ Errore parsing JSON. Il Delfino ha fatto indigestione.");
        return [];
    }
}

// ─────────────────────────────────────────────
//  Costruzione delle Sezioni
// ─────────────────────────────────────────────
async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";

  console.log(`\n${label} — Ricerca e Scrittura Notizie...`);
  
  const systemPrompt = `Sei un redattore italiano pungente e sarcastico. 
  Rispondi SOLO con un array JSON puro. 
  Oggetti con chiavi: titolo, categoria, sommario, commento, fonte, luogo.`;

  const userPrompt = isPescara
    ? `Cerca 8 notizie vere di oggi (${today}) su Pescara/Abruzzo. Temi: sport, cultura, gastronomia. JSON array.`
    : `Oggi è ${today}. Cerca 8 notizie interessanti dal mondo. Temi: tech, scienza, scoperte. JSON array.`;

  const rawJson = await callGemini({
    system: systemPrompt,
    prompt: userPrompt,
    useSearch: true,
    maxTokens: 4000,
    isJson: true
  });

  let allNews = parseNews(rawJson).map(n => ({ ...n, isFake: false, svg: null }));

  console.log(`${label} — Aggiungo la Satira...`);
  const satiraRaw = await callGemini({
    system: "Inventa una notizia satirica assurda e palesemente falsa. Rispondi SOLO in JSON.",
    prompt: isPescara ? "Satira su Pescara/Arrosticini/Spiaggia" : "Satira su Intelligenza Artificiale o Politica Estera",
    maxTokens: 600,
    isJson: true
  });
  
  const satiraObj = parseNews(satiraRaw);
  const finalSatira = Array.isArray(satiraObj) ? satiraObj[0] : satiraObj;
  if(finalSatira) allNews.push({ ...finalSatira, isFake: true, svg: null });

  console.log(`${label} — Generazione Illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    try {
        const svgCode = await callGemini({
            system: "Sei un grafico. Rispondi SOLO con il codice XML/HTML di un tag <svg>.",
            prompt: `Crea un SVG minimalista a colori pastello per questa notizia: "${item.titolo}". ViewBox="0 0 900 400". Output solo codice <svg>.`,
            maxTokens: 1500
        });
        item.svg = svgCode.match(/<svg[\s\S]*?<\/svg>/i)?.[0] || null;
        process.stdout.write(item.svg ? "✓ " : "✗ ");
    } catch (e) {
        process.stdout.write("! ");
    }
    await new Promise(r => setTimeout(r, 1500)); // Breve respiro tra gli SVG
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

// ─────────────────────────────────────────────
//  Avvio
// ─────────────────────────────────────────────
async function main() {
  console.log("🐬 La Voce del Delfino — Avvio di Produzione");
  
  try {
    await autoDiscoverModel(); // Scopre il modello funzionante!
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

main();
