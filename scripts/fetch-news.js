#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino (Versione Aggiornata)
 * FIX APPLICATI: 
 * - Parser JSON antiproiettile (ignora testo spazzatura)
 * - Schema Satira bloccato per evitare scarti
 * - Prompt SVG rinforzato
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data"); // Assicurati che punti alla cartella corretta su GitHub Actions
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { 
  console.error("❌ GEMINI_API_KEY mancante. Inseriscila nel tuo ambiente o nei Secrets di GitHub"); 
  process.exit(1); 
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today    = new Date().toLocaleDateString("it-IT", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});

let WORKING_MODEL = null;
let callCount = 0;

async function autoDiscoverModel() {
  console.log("🔍 Interrogo Google per trovare i modelli disponibili...");
  const res = await fetch(`${BASE_URL}/models?key=${API_KEY}`);
  if (!res.ok) throw new Error(`Impossibile recuperare la lista dei modelli.`);

  const data = await res.json();
  const flashModels = data.models.filter(m => 
    m.supportedGenerationMethods?.includes("generateContent") && m.name.includes("flash")
  );

  if (flashModels.length === 0) throw new Error("Nessun modello 'Flash' abilitato trovato.");
  const bestModel = flashModels.find(m => m.name.includes("2.5")) || flashModels.find(m => m.name.includes("2.0")) || flashModels[0];
  console.log(`✅ Modello compatibile agganciato: ${bestModel.name}`);
  WORKING_MODEL = bestModel.name; 
}

async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096, isJson = false, retries = 0 }) {
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
  
  if (isJson && !useSearch) body.generationConfig.response_mime_type = "application/json";
  if (system) body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  const url = `${BASE_URL}/${WORKING_MODEL}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
        console.log(`\n⚠️ 429 Rilevato! Motivo: ${errText.slice(0, 150)}`);
        if (errText.toLowerCase().includes("quota")) throw new Error("QUOTA GIORNALIERA ESAURITA!");
        if (retries >= 3) throw new Error("Troppi tentativi falliti. Mi arrendo.");
        console.log(`⏳ GitHub IP lento. Ritento tra 60 secondi... (Tentativo ${retries + 1} di 3)`);
        await new Promise(r => setTimeout(r, 60_000));
        return callGemini({ system, prompt, useSearch, maxTokens, isJson, retries: retries + 1 });
    }
    throw new Error(`API HTTP ${res.status}: ${errText.slice(0,150)}`);
  }

  const data = await res.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  await new Promise(r => setTimeout(r, 10_000)); 
  return textResponse;
}

// ─────────────────────────────────────────────
//  PARSER ANTIPROIETTILE (Ignora testo extra)
// ─────────────────────────────────────────────
function parseNews(text) {
    try {
        let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
        const firstBracket = cleaned.search(/\[|\{/);
        const lastBracket = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
        
        if (firstBracket !== -1 && lastBracket !== -1) {
            cleaned = cleaned.substring(firstBracket, lastBracket + 1);
        }
        return JSON.parse(cleaned);
    } catch (e) {
        console.error("❌ Errore parsing JSON. Spazzatura rimossa dal Delfino.");
        return []; 
    }
}

async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";
  const NUM_ARTICOLI = 12;

  console.log(`\n${label} — Ricerca e Scrittura Notizie...`);
  const rawJson = await callGemini({
    system: `Sei un redattore pungente. Rispondi SOLO con un array JSON puro. NESSUN TESTO EXTRA. Chiavi: titolo, categoria, sommario, commento, fonte, luogo.`,
    prompt: isPescara
      ? `Cerca ${NUM_ARTICOLI} notizie VERE di oggi (${today}) su Pescara/Abruzzo. Temi vari. Array JSON.`
      : `Oggi è ${today}. Cerca ${NUM_ARTICOLI} notizie VERE dal mondo. Temi vari. Array JSON.`,
    useSearch: true,
    maxTokens: 4000
  });

  let allNews = parseNews(rawJson);
  if (!Array.isArray(allNews)) allNews = [allNews]; // Salva-vita nel caso non fosse un array
  allNews = allNews.map(n => ({ ...n, isFake: false, svg: null }));

  console.log(`${label} — Aggiungo la Satira...`);
  const satiraRaw = await callGemini({
    system: `Inventa una notizia satirica assurda. Rispondi SOLO in JSON puro. DEVI USARE ESATTAMENTE QUESTE CHIAVI: "titolo", "categoria", "sommario", "commento", "fonte", "luogo".`,
    prompt: isPescara ? "Satira su Pescara (es. arrosticini, mare). Fonte: 'Il Delfino Sognatore'" : "Satira tecnologica assurda. Fonte: 'Il Delfino Sognatore'",
    maxTokens: 2000,
    isJson: true 
  });
  
  const satiraObj = parseNews(satiraRaw);
  const finalSatira = Array.isArray(satiraObj) ? satiraObj[0] : satiraObj;
  if(finalSatira && finalSatira.titolo) {
      allNews.push({ ...finalSatira, isFake: true, svg: null });
  } else {
      console.log("⚠️ Satira non aggiunta: chiavi mancanti.");
  }

  console.log(`${label} — Generazione Illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    try {
        const svgCode = await callGemini({
            system: `Sei un generatore automatico di codice SVG. Devi restituire ESCLUSIVAMENTE il codice <svg> crudo. Niente markdown.`,
            prompt: `Genera un <svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg">. Astratto, minimalista (max 8 forme). Colori pastello. Rappresenta: "${item.titolo}". Chiudi il tag </svg>.`,
            maxTokens: 2000 
        });
        const match = svgCode.match(/<svg[\s\S]*?<\/svg>/i);
        if (match) {
            item.svg = match[0];
            process.stdout.write("✓ ");
        } else {
            process.stdout.write("✗ ");
        }
    } catch (e) {
        process.stdout.write(`! `);
    }
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

async function main() {
  console.log("🐬 La Voce del Delfino — Avvio di Produzione");
  try {
    await autoDiscoverModel();
  } catch (error) {
    console.error("❌ Impossibile avviare il sistema:", error.message);
    process.exit(1);
  }

  for (const isPescara of [falwse, true]) {
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
