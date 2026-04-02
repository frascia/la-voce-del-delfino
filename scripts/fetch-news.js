#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino
 * Gemini API free tier ottimizzato: ~25 chiamate totali per run
 * (1 ricerca+formato per sezione + 1 satira per sezione + ~10 SVG per sezione)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("❌ GEMINI_API_KEY mancante"); process.exit(1); }

const MODEL   = "gemini-2.0-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today = new Date().toLocaleDateString("it-IT", {
  weekday:"long", year:"numeric", month:"long", day:"numeric"
});

// ─────────────────────────────────────────────
//  Gemini API con retry automatico su 429
// ─────────────────────────────────────────────
async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096 }, retries = 3) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 }
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (useSearch) body.tools = [{ google_search: {} }];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(
      `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }
    );

    if (res.status === 429) {
      // Rate limit: aspetta progressivamente di più
      const wait = (attempt + 1) * 15000; // 15s, 30s, 45s
      console.log(`  ⏳ Rate limit 429, aspetto ${wait/1000}s (tentativo ${attempt+1}/${retries})...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") ?? "";
    if (!text) throw new Error("Risposta vuota da Gemini");
    return text;
  }
  throw new Error("Rate limit persistente dopo tutti i tentativi");
}

// Pausa fissa tra chiamate (rispetta 15 req/min = 4s minimo)
const pause = (ms = 5000) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
//  Helpers JSON / SVG
// ─────────────────────────────────────────────
function extractJSON(text) {
  const clean = text.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  const si=clean.indexOf("["), ei=clean.lastIndexOf("]");
  if(si!==-1&&ei>si){
    const c=clean.slice(si,ei+1);
    try{return JSON.parse(c);}catch{}
    try{return JSON.parse(c.replace(/,\s*([}\]])/g,"$1").replace(/[\x00-\x1F\x7F]/g," "));}catch{}
  }
  const si2=clean.indexOf("{"),ei2=clean.lastIndexOf("}");
  if(si2!==-1&&ei2>si2){try{return [JSON.parse(clean.slice(si2,ei2+1))];}catch{}}
  throw new Error("JSON non trovato");
}

function extractSVG(text) {
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  return m[0].replace(/<svg([^>]*)>/, (_,a) => {
    const vb = a.includes("viewBox") ? a : a+' viewBox="0 0 900 400"';
    return `<svg${vb.replace(/width="[^"]*"/,"").replace(/height="[^"]*"/,"")} style="width:100%;height:100%;display:block;">`;
  });
}

// ─────────────────────────────────────────────
//  STEP 1+2 unificati: cerca e formatta in una sola chiamata
// ─────────────────────────────────────────────
async function fetchAndFormat(isPescara) {
  const cats = isPescara
    ? "Mare & Spiaggia, Cultura Locale, Sport Locale, Città & Infrastrutture, Gastronomia, Ambiente, Cronaca, Eventi & Sagre"
    : "Scienza, Natura, Salute, Tecnologia, Cultura, Animali, Spazio, Innovazione, Gastronomia, Sport, Ambiente";

  const txt = await callGemini({
    useSearch: true,
    maxTokens: 6000,
    system: `Sei un redattore italiano sarcastico — tra Nanni Moretti e un comico da avanspettacolo.
Cerca le notizie con Google Search, poi restituisci DIRETTAMENTE un array JSON.
ZERO testo prima o dopo. ZERO backtick. Solo l'array JSON.
Array di ESATTAMENTE 10 oggetti con chiavi: titolo, categoria, sommario, commento, fonte, luogo.
"commento": sarcastico, ironico, divertente con battuta finale. MAI serio.`,
    prompt: isPescara
      ? `Cerca 10 notizie recenti di Pescara e Abruzzo (${today}): sport, cultura, gastronomia, cronaca positiva, eventi, lungomare. Restituisci JSON array:\n[{"titolo":"...","categoria":"una di: ${cats}","sommario":"2-3 frasi","commento":"sarcastico con battuta finale","fonte":"nome fonte","luogo":"zona Pescara"}]`
      : `Cerca 10 notizie positive o interessanti dal mondo (${today}): scienza, natura, spazio, animali, tech, cultura, sport. Restituisci JSON array:\n[{"titolo":"...","categoria":"una di: ${cats}","sommario":"2-3 frasi","commento":"sarcastico con battuta finale","fonte":"nome fonte","luogo":"Paese/città"}]`
  });

  const parsed = extractJSON(txt);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Nessuna notizia nel JSON");

  return parsed.slice(0,10).map((x,i) => ({
    titolo:    x.titolo    || `Notizia ${i+1}`,
    categoria: x.categoria || (isPescara ? "Pescara" : "Mondo"),
    sommario:  x.sommario  || "",
    commento:  x.commento  || "",
    fonte:     x.fonte     || "Fonte",
    luogo:     x.luogo     || (isPescara ? "Pescara" : "—"),
    isFake: false, svg: null
  }));
}

// ─────────────────────────────────────────────
//  Notizia satirica
// ─────────────────────────────────────────────
async function generateSatira(isPescara) {
  const txt = await callGemini({
    maxTokens: 500,
    system: `Satirico italiano. Inventa una notizia FALSA, assurda, originale, SEMPRE DIVERSA.
SOLO JSON puro. Zero testo. Zero backtick.`,
    prompt: isPescara
      ? `Notizia satirica originale su Pescara/Abruzzo (comune, arrosticini, spiaggia, delfino-mascotte, turisti, sagre). JSON: {"titolo":"...","categoria":"Cronaca Locale","sommario":"2-3 frasi comiche","commento":"battuta feroce finale","luogo":"zona Pescara"}`
      : `Notizia satirica originale mondiale (scienza folle, politici bizzarri, animali umani, tech inutile, AI). JSON: {"titolo":"...","categoria":"...","sommario":"2-3 frasi comiche","commento":"battuta feroce finale","luogo":"città, paese"}`
  });
  const parsed = extractJSON(txt);
  const s = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    titolo:    s.titolo    || "Notizia satirica",
    categoria: s.categoria || (isPescara ? "Cronaca Locale" : "Scienza"),
    sommario:  s.sommario  || "",
    commento:  s.commento  || "",
    fonte:     "La Voce del Delfino — Redazione Satirica",
    luogo:     s.luogo     || (isPescara ? "Pescara" : "Mondo"),
    isFake: true, svg: null
  };
}

// ─────────────────────────────────────────────
//  Illustrazione SVG Ghibli
// ─────────────────────────────────────────────
async function generateSVG(titolo, sommario, isFake) {
  try {
    const txt = await callGemini({
      maxTokens: 1800,
      system: `Artista Studio Ghibli. Crea SVG acquerello che mostri la SCENA SPECIFICA della notizia.
Non paesaggi generici — raffigura il contenuto reale:
calcio→campo+giocatori, protesta→folla+cartelli, spazio→pianeta specifico,
animale→nel suo habitat, incendio→fiamme+fumo, festival→palco+folla,
scienza→laboratorio, mare→onde+barche, cibo→tavola imbandita, tech→robot Ghibli.
STILE: acquerello pastello morbido, poetico.
viewBox="0 0 900 400"
RISPOSTA: SOLO codice SVG. Inizia con <svg, finisci con </svg>.
Solo elementi SVG nativi: rect,circle,ellipse,path,polygon,line,text,g,defs,linearGradient,radialGradient,filter.`,
      prompt: `"${titolo}"\n${sommario}${isFake?" (satirica — puoi essere umoristico)":""}\n\nDisegna.`
    });
    return extractSVG(txt);
  } catch(e) {
    console.warn(`  ⚠️  SVG fallito: ${e.message.slice(0,80)}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  Pipeline per una sezione
// ─────────────────────────────────────────────
async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";

  // 1 chiamata: cerca + formatta JSON
  console.log(`\n${label} — Cerco e formato 10 notizie...`);
  const news = await fetchAndFormat(isPescara);
  await pause(6000);

  // 1 chiamata: satira
  console.log(`${label} — Genero satira...`);
  const satira = await generateSatira(isPescara);
  const allNews = [...news, satira];
  await pause(6000);

  // 11 chiamate: SVG una alla volta con pausa
  console.log(`${label} — Genero ${allNews.length} illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    process.stdout.write(`  [${i+1}/${allNews.length}] "${item.titolo.slice(0,40)}"... `);
    item.svg = await generateSVG(item.titolo, item.sommario, item.isFake);
    console.log(item.svg ? "✓" : "✗");
    // 5s tra SVG per stare nei 15 req/min
    if (i < allNews.length - 1) await pause(5000);
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

// ─────────────────────────────────────────────
//  Main — le due sezioni in sequenza con pausa
// ─────────────────────────────────────────────
async function main() {
  console.log("🐬 La Voce del Delfino — Gemini Edition");
  console.log(`📅 ${today}`);
  console.log("📊 ~26 chiamate API totali (13 per sezione)\n");

  const errors = [];

  for (const isPescara of [false, true]) {
    try {
      const data  = await buildSection(isPescara);
      const fname = isPescara ? "news-pescara.json" : "news-mondo.json";
      fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(data, null, 2), "utf8");
      console.log(`\n✅ Salvato ${fname} (${data.news.length} articoli)`);
    } catch(e) {
      console.error(`\n❌ Errore ${isPescara?"Pescara":"Mondo"}: ${e.message}`);
      errors.push(e.message);
    }

    // Pausa di 2 minuti tra le due sezioni per azzerare il rate limit
    if (!isPescara) {
      console.log("\n⏸️  Pausa 2 minuti tra le sezioni per rispettare rate limit...");
      await pause(120000);
    }
  }

  fs.writeFileSync(
    path.join(DATA_DIR, "meta.json"),
    JSON.stringify({ lastUpdate: new Date().toISOString(), errors }, null, 2)
  );

  if (errors.length === 2) process.exit(1);
  console.log("\n🎉 Completato!");
}

main().catch(e => { console.error(e); process.exit(1); });
