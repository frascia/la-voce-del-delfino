#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino (Versione Definitiva e Stabile)
 * Include:
 * 1. Auto-Discovery del modello per evitare errori 404.
 * 2. Risoluzione conflitto JSON vs Google Search (Errore 400).
 * 3. Parser robusto antiproiettile per il Markdown.
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
  
  // Il campo .name di Google include già "models/" (es. "models/gemini-2.5-flash")
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
  
  // Aggiungiamo isJson SOLO se non stiamo usando la ricerca
  // (L'API vieta l'uso contemporaneo di tool di ricerca e response_mime_type)
  if (isJson && !useSearch) {
      body.generationConfig.response_mime_type = "application/json";
  }
  
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
    // Gestione automat
