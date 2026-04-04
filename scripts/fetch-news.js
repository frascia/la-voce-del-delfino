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
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 } // Abbassata temp per renderlo più ubbidiente col JSON
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

// PARSER ESTREMAMENTE AGGRESSIVO
function parseNews(text) {
    try {
        let clean = text.replace(/
http://googleusercontent.com/immersive_entry_chip/0

---

### 2. Svuotare la cache del cellulare (Fondamentale!)
Il tuo file HTML di prima andava già bene per i font grandi, ma il tuo telefono si ostina a caricare la vecchia versione dalla sua memoria. 

**Per forzare il telefono ad aggiornare:**
1. Apri il sito sul cellulare.
2. Vai nella barra dell'indirizzo in alto.
3. Aggiungi alla fine del link questo trucco: `?v=2`
   Es: `https://frascia.github.io/la-voce-del-delfino/?v=2`
4. Premi Invio/Vai. 

Questo inganna il telefono facendogli credere che sia un sito nuovo, costringendolo a scaricare i caratteri grandi e l'impalcatura per le immagini!

Carica il file `.js` su GitHub, aspetta che la rotellina (Action) finisca, usa il trucchetto del `?v=2` sul telefono e ci siamo.
                
