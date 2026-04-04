#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data"); 
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { 
  console.error("❌ GEMINI_API_KEY mancante."); 
  process.exit(1); 
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today    = new Date().toLocaleDateString("it-IT", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

let WORKING_MODEL = null;
let callCount = 0;

async function autoDiscoverModel() {
  const res = await fetch(`${BASE_URL}/models?key=${API_KEY}`);
  if (!res.ok) throw new Error("Errore API Key");
  const data = await res.json();
  const flashModels = data.models.filter(m => m.supportedGenerationMethods?.includes("generateContent") && m.name.includes("flash"));
  WORKING_MODEL = flashModels.find(m => m.name.includes("2.5"))?.name || flashModels[0]?.name; 
}

async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096, isJson = false, retries = 0 }) {
  if (callCount > 0 && callCount % 10 === 0) await new Promise(r => setTimeout(r, 60_000));
  callCount++;
  
  const body = {
    contents: [{ role:"user", parts:[{ text:prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
  };
  
  if (isJson && !useSearch) body.generationConfig.response_mime_type = "application/json";
  if (system) body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  const res = await fetch(`${BASE_URL}/${WORKING_MODEL}:generateContent?key=${API_KEY}`, { 
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) 
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429 && retries < 3) {
        await new Promise(r => setTimeout(r, 60_000));
        return callGemini({ system, prompt, useSearch, maxTokens, isJson, retries: retries + 1 });
    }
    throw new Error(`API HTTP ${res.status}`);
  }

  const data = await res.json();
  await new Promise(r => setTimeout(r, 10_000)); 
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// PARSER BASICO, SICURO E A PROVA DI BOMBA
function parseNews(text) {
    try {
        // Togliamo i backtick in modo semplice e lineare, senza regex che si rompono
        let clean = text.replace(/```json/gi, "")
                        .replace(/```html/gi, "")
                        .replace(/```xml/gi, "")
                        .replace(/```/g, "")
                        .trim();

        // Trova dove inizia e finisce il vero codice
        let start = Math.min(...[clean.indexOf('['), clean.indexOf('{')].filter(i => i !== -1));
        let end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
        
        if (start !== -1 && end !== -1) {
            return JSON.parse(clean.substring(start, end + 1));
        }
        throw new Error("Nessuna parentesi trovata");
    } catch (e) {
        console.error("❌ Errore JSON. L'IA ha scritto spazzatura.");
        return []; 
    }
}

async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";
  const NUM_ARTICOLI = 12;

  console.log(`\n${label} — Ricerca e Scrittura Notizie...`);
  const rawJson = await callGemini({
    system: `Devi restituire ESCLUSIVAMENTE un ARRAY JSON VALIDO, senza markdown e senza testo prima o dopo. Modello esatto: [{"titolo":"...","categoria":"...","sommario":"...","commento":"...","fonte":"...","luogo":"..."}]`,
    prompt: isPescara
      ? `Oggi è ${today}. Cerca ${NUM_ARTICOLI} notizie vere su Pescara/Abruzzo. Output: Array JSON.`
      : `Oggi è ${today}. Cerca ${NUM_ARTICOLI} notizie vere dal mondo. Output: Array JSON.`,
    useSearch: true,
    maxTokens: 4000
  });

  let allNews = parseNews(rawJson);
  if (!Array.isArray(allNews)) allNews = [allNews];
  allNews = allNews.map(n => ({ ...n, isFake: false, svg: null }));

  console.log(`${label} — Aggiungo la Satira...`);
  const satiraRaw = await callGemini({
    system: `Devi restituire ESCLUSIVAMENTE un OGGETTO JSON. Chiavi esatte: "titolo", "categoria", "sommario", "commento", "fonte", "luogo".`,
    prompt: isPescara ? "Inventa una notizia assurda e satirica su Pescara." : "Inventa una notizia assurda e satirica sul mondo tech.",
    maxTokens: 2000,
    isJson: true 
  });
  
  const finalSatira = parseNews(satiraRaw);
  if(!Array.isArray(finalSatira) && finalSatira.titolo) {
      allNews.push({ ...finalSatira, isFake: true, svg: null });
  }

  console.log(`${label} — Generazione Illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    try {
        const svgCode = await callGemini({
            system: `Sei un compilatore. Output: SOLO ED ESCLUSIVAMENTE codice <svg>. Vieta qualsiasi spiegazione. Inizia con <svg e finisci con </svg>.`,
            prompt: `Genera codice per <svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg"> con forme geometriche astratte pastello che rappresenti: "${allNews[i].titolo}". Chiudi con </svg>.`,
            maxTokens: 2000 
        });
        const match = svgCode.match(/<svg[\s\S]*?<\/svg>/i);
        if (match) {
            allNews[i].svg = match[0];
            process.stdout.write("✓ ");
        } else {
            process.stdout.write("✗ ");
        }
    } catch (e) {
        process.stdout.write(`! `);
    }
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews.filter(n => n.titolo) };
}

async function main() {
  await autoDiscoverModel();
  for (const isPescara of [false, true]) {
    const data = await buildSection(isPescara);
    fs.writeFileSync(path.join(DATA_DIR, isPescara ? "news-pescara.json" : "news-mondo.json"), JSON.stringify(data, null, 2));
    console.log(`\n✅ Sezione salvata.`);
  }
}

main();
