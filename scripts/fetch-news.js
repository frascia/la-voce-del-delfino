#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino (Ottimizzato Gemini Free)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("❌ GEMINI_API_KEY mancante"); process.exit(1); }

const MODEL    = "gemini-1.5-flash"; // Usiamo Flash per velocità e limiti più alti
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today    = new Date().toLocaleDateString("it-IT", {
  weekday:"long", year:"numeric", month:"long", day:"numeric"
});

let callCount = 0;

async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096 }) {
  // Rate limit: 10 chiamate al minuto. Pausa di 65 secondi ogni 10.
  if (callCount > 0 && callCount % 10 === 0) {
    console.log(`\n ⏸️  Rate limit raggiunto (${callCount}) — pausa di 65s per ricaricare...`);
    await new Promise(r => setTimeout(r, 65_000));
  }

  callCount++;
  console.log(`  [Chiamata #${callCount}]`);

  const body = {
    contents: [{ role:"user", parts:[{ text:prompt }] }],
    generationConfig: { 
      maxOutputTokens: maxTokens, 
      temperature: 1.0, // Più alto per più sarcasmo
      response_mime_type: "application/json" // Forza Gemini a rispondere in JSON
    }
  };
  
  if (system) body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  const res = await fetch(
    `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`,
    { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }
  );

  if (!res.ok) {
    const err = await res.text();
    // Se riceviamo 429 (Too Many Requests), aspettiamo forzatamente
    if (res.status === 429) {
        console.log("⚠️ Errore 429 rilevato. Pausa forzata di 30s...");
        await new Promise(r => setTimeout(r, 30_000));
        return callGemini({ system, prompt, useSearch, maxTokens });
    }
    throw new Error(`Gemini API ${res.status}: ${err.slice(0,200)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Helper per pulire l'output ed evitare crash
function parseNews(text) {
    try {
        const cleaned = text.trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.error("❌ Fallito parsing JSON. Testo ricevuto:", text.slice(0, 100));
        return [];
    }
}

async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";
  const newsCount = 10; // Ridotto a 10 per garantire qualità e restare nei token

  console.log(`\n${label} — Step 1: Ricerca e Formattazione...`);
  
  const systemPrompt = `Sei un redattore italiano sarcastico. 
  Rispondi SOLO in formato JSON (array di oggetti). 
  Chiavi: titolo, categoria, sommario, commento, fonte, luogo.
  Commento: sarcastico e pungente.`;

  const userPrompt = isPescara
    ? `Cerca e descrivi 10 notizie recenti di Pescara e Abruzzo (${today}). Temi: sport, cultura, eventi. JSON array.`
    : `Oggi è ${today}. Trova 10 notizie interessanti dal mondo. Temi: tech, scienza, spazio. JSON array.`;

  const rawJson = await callGemini({
    system: systemPrompt,
    prompt: userPrompt,
    useSearch: true,
    maxTokens: 4000
  });

  let allNews = parseNews(rawJson).map(n => ({ ...n, isFake: false, svg: null }));

  console.log(`${label} — Step 2: Notizia satirica...`);
  const satiraRaw = await callGemini({
    system: "Inventa una notizia satirica assurda e falsa. Rispondi in JSON.",
    prompt: isPescara ? "Satira su Pescara/Arrosticini" : "Satira su AI e Futuro",
    maxTokens: 500
  });
  
  const satiraObj = parseNews(satiraRaw);
  const finalSatira = Array.isArray(satiraObj) ? satiraObj[0] : satiraObj;
  if(finalSatira) allNews.push({ ...finalSatira, isFake: true, svg: null });

  console.log(`${label} — Step 3: Generazione ${allNews.length} illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    // Chiamata per SVG
    const svgPrompt = `Crea un SVG in stile acquerello Ghibli per: ${item.titolo}. Solo codice <svg>.`;
    try {
        const svgCode = await callGemini({
            system: "Sei un artista SVG. Genera solo codice <svg> pulito.",
            prompt: svgPrompt,
            maxTokens: 1500
        });
        item.svg = svgCode.match(/<svg[\s\S]*?<\/svg>/i)?.[0] || null;
        process.stdout.write(item.svg ? "✓ " : "✗ ");
    } catch (e) {
        process.stdout.write("! ");
    }
    // Piccola pausa per non stressare l'API tra gli SVG
    await new Promise(r => setTimeout(r, 1000));
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

async function main() {
  console.log("🐬 La Voce del Delfino — Ottimizzato");
  
  for (const isPescara of [false, true]) {
    try {
      const data = await buildSection(isPescara);
      const fname = isPescara ? "news-pescara.json" : "news-mondo.json";
      fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(data, null, 2));
      console.log(`\n✅ Salvato ${fname}`);
    } catch(e) {
      console.error(`\n❌ Errore: ${e.message}`);
    }
  }
}

main();
