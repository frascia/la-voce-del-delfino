#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino
 * Ottimizzato: Batch di 10 chiamate ogni 2 minuti
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL   = "gemini-2.0-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Configurazione Rate Limit
const MAX_REQ_PER_BATCH = 10; 
const BATCH_WAIT_MS = 130000; // 2 minuti e 10 secondi per sicurezza
const INTER_REQ_MS = 5000;    // 5 secondi tra singole req nel batch

let globalRequestCount = 0;

async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096 }) {
  // Controllo batch
  if (globalRequestCount > 0 && globalRequestCount % MAX_REQ_PER_BATCH === 0) {
    console.log(`\n       🛑 Limite batch raggiunto (${MAX_REQ_PER_BATCH} req).`);
    console.log(`       ⏳ Pausa di raffreddamento: 2 minuti...`);
    await new Promise(r => setTimeout(r, BATCH_WAIT_MS));
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 }
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (useSearch) body.tools = [{ google_search: {} }];

  const res = await fetch(
    `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );

  if (!res.ok) throw new Error(`Gemini API Error: ${res.status}`);

  globalRequestCount++;
  
  // Piccola pausa tra chiamate singole per non saturare i thread
  await new Promise(r => setTimeout(r, INTER_REQ_MS));

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") ?? "";
}

// ... (tieni le funzioni extractJSON e extractSVG del tuo script originale)

async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";
  
  console.log(`\n${label} — Avvio recupero dati...`);
  
  // 1. Fetch Notizie (1 req)
  const news = await fetchAndFormat(isPescara); 
  
  // 2. Satira (1 req)
  const satira = await generateSatira(isPescara);
  const allNews = [...news, satira];

  // 3. SVG (11 req)
  console.log(`${label} — Generazione illustrazioni (Batch-aware)...`);
  for (let i = 0; i < allNews.length; i++) {
    process.stdout.write(`  [${i+1}/${allNews.length}] "${allNews[i].titolo.slice(0,30)}"... `);
    allNews[i].svg = await generateSVG(allNews[i].titolo, allNews[i].sommario, allNews[i].isFake);
    console.log(allNews[i].svg ? "✓" : "✗");
  }

  return { generatedAt: new Date().toISOString(), news: allNews };
}

async function main() {
  console.log("🐬 La Voce del Delfino — Modalità Risparmio Energetico (e API)");
  
  // Esegue Mondo e Pescara in sequenza. 
  // Il contatore globale gestirà le pause ogni 10 chiamate totali.
  for (const isPescara of [false, true]) {
    const data = await buildSection(isPescara);
    const fname = isPescara ? "news-pescara.json" : "news-mondo.json";
    fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(data, null, 2));
    console.log(`✅ File ${fname} salvato.`);
  }
}

main();
