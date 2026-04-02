#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino
 * Gemini free tier: max 10 chiamate poi pausa 2 min, poi altre 10, ecc.
 * Struttura originale: 20 notizie + satira + 21 SVG per sezione
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("❌ GEMINI_API_KEY mancante"); process.exit(1); }

const MODEL    = "gemini-2.0-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today    = new Date().toLocaleDateString("it-IT", {
  weekday:"long", year:"numeric", month:"long", day:"numeric"
});

// ─────────────────────────────────────────────
//  Rate limiter: max 10 chiamate poi pausa 2min
// ─────────────────────────────────────────────
let callCount = 0;

async function callGemini({ system, prompt, useSearch = false, maxTokens = 4096 }) {
  // Ogni 10 chiamate, aspetta 2 minuti prima di continuare
  if (callCount > 0 && callCount % 5 === 0) {
    console.log(`\n  ⏸️  Raggiunte ${callCount} chiamate — pausa 2 minuti per rate limit...\n`);
    await new Promise(r => setTimeout(r, 2 * 60_000));
  }

  callCount++;
  console.log(`  [chiamata #${callCount}]`);

  const body = {
    contents: [{ role:"user", parts:[{ text:prompt }] }],
    generationConfig: { maxOutputTokens:maxTokens, temperature:0.9 }
  };
  if (system)    body.system_instruction = { parts:[{ text:system }] };
  if (useSearch) body.tools = [{ google_search:{} }];

  const res = await fetch(
    `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`,
    { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.slice(0,200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text||"").join("") ?? "";
  if (!text) throw new Error("Risposta vuota da Gemini");

  // Piccola pausa tra chiamate consecutive (evita burst)
  await new Promise(r => setTimeout(r, 1500));

  return text;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function extractJSON(text) {
  const clean = text.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  const si=clean.indexOf("["), ei=clean.lastIndexOf("]");
  if (si!==-1 && ei>si) {
    const c = clean.slice(si, ei+1);
    try { return JSON.parse(c); } catch {}
    try { return JSON.parse(c.replace(/,\s*([}\]])/g,"$1").replace(/[\x00-\x1F\x7F]/g," ")); } catch {}
  }
  const si2=clean.indexOf("{"), ei2=clean.lastIndexOf("}");
  if (si2!==-1 && ei2>si2) { try { return [JSON.parse(clean.slice(si2,ei2+1))]; } catch {} }
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
//  Step 1 — Ricerca notizie (Google Search)
// ─────────────────────────────────────────────
async function stepRicerca(isPescara) {
  return callGemini({
    useSearch: true,
    maxTokens: 6000,
    prompt: isPescara
      ? `Cerca e descrivi 5 notizie recenti di Pescara e Abruzzo (${today}). Temi: sport locale, cultura, gastronomia, cronaca positiva, economia, eventi, lungomare, infrastrutture, natura, turismo. Per ognuna: titolo, fonte, luogo preciso, descrizione dettagliata.`
      : `Oggi è ${today}. Trova 5 notizie recenti, positive o interessanti dal mondo. Temi vari: scienza, natura, spazio, animali, tecnologia, cultura, sport, gastronomia, economia, ambiente, salute. Per ognuna: titolo, paese/città, fonte, descrizione dettagliata.`
  });
}

// ─────────────────────────────────────────────
//  Step 2 — Formatta in JSON sarcastico
// ─────────────────────────────────────────────
async function stepFormatta(raw, isPescara) {
  const cats = isPescara
    ? "Mare & Spiaggia, Cultura Locale, Sport Locale, Città & Infrastrutture, Gastronomia, Ambiente, Cronaca, Eventi & Sagre, Economia Locale"
    : "Scienza, Natura, Salute, Tecnologia, Cultura, Animali, Spazio, Innovazione, Gastronomia, Sport, Economia, Ambiente";

  const txt = await callGemini({
    maxTokens: 8000,
    system: `Sei un redattore italiano sarcastico — tra Nanni Moretti e un comico da avanspettacolo.
Trasforma le notizie in JSON puro. ZERO backtick, ZERO testo prima o dopo l'array.
Array di ESATTAMENTE 20 oggetti con chiavi: titolo, categoria, sommario, commento, fonte, luogo.
Il campo "commento" DEVE essere sarcastico, ironico, divertente con battuta finale. MAI serio.`,
    prompt: `Notizie trovate:\n\n${raw}\n\nJSON (5 oggetti):\n[{"titolo":"...","categoria":"una di: ${cats}","sommario":"2-3 frasi","commento":"sarcastico con battuta finale","fonte":"...","luogo":"${isPescara?"zona Pescara":"Paese/città"}"}]`
  });

  const parsed = extractJSON(txt);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Nessuna notizia nel JSON");

  return parsed.slice(0,20).map((x,i) => ({
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
//  Step 3 — Notizia satirica
// ─────────────────────────────────────────────
async function stepSatira(isPescara) {
  const txt = await callGemini({
    maxTokens: 500,
    system: `Satirico italiano geniale. Inventa notizia FALSA, assurda, originale, sempre diversa.
SOLO JSON puro. Zero testo. Zero backtick.`,
    prompt: isPescara
      ? `Notizia satirica originale su Pescara/Abruzzo (comune, arrosticini, spiaggia, delfino-mascotte, turisti, sagre). JSON: {"titolo":"...","categoria":"Cronaca Locale","sommario":"2-3 frasi comiche","commento":"battuta feroce finale","luogo":"zona Pescara"}`
      : `Notizia satirica originale mondiale (scienza folle, politici bizzarri, animali umani, tech inutile, AI, burocrazia). JSON: {"titolo":"...","categoria":"...","sommario":"2-3 frasi comiche","commento":"battuta feroce finale","luogo":"città, paese"}`
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
//  Step 4 — Illustrazioni SVG (una alla volta)
// ─────────────────────────────────────────────
async function stepSVG(titolo, sommario, isFake) {
  try {
    const txt = await callGemini({
      maxTokens: 2000,
      system: `Artista Studio Ghibli. Crea SVG acquerello che mostri la SCENA SPECIFICA della notizia.
Non paesaggi generici — raffigura il contenuto reale della notizia:
calcio→campo+giocatori+pallone, protesta→folla+cartelli+piazza,
spazio→pianeta specifico+stelle, animale→nel suo habitat naturale,
incendio→fiamme+fumo+pompieri, festival→palco+folla+lanterne,
elezioni→urne+bandiere+palazzo, scienza→laboratorio+microscopi,
mare→onde+barche+pesci, cibo→tavola imbandita+vapore, tech→robot Ghibli.
STILE: acquerello Ghibli, pastello morbido, poetico.
viewBox="0 0 900 400". RISPOSTA: SOLO SVG. <svg...>...</svg>.
Solo elementi nativi: rect,circle,ellipse,path,polygon,line,text,g,defs,linearGradient,radialGradient,filter.`,
      prompt: `"${titolo}"\n${sommario}${isFake?" (è satirica — puoi essere umoristico)":""}\n\nDisegna la scena SVG.`
    });
    return extractSVG(txt);
  } catch(e) {
    console.warn(`    ⚠️  SVG fallito: ${e.message.slice(0,80)}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  Pipeline per una sezione
// ─────────────────────────────────────────────
async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";

  console.log(`\n${label} — Step 1: ricerca notizie (Google Search)...`);
  const raw = await stepRicerca(isPescara);

  console.log(`${label} — Step 2: formato in JSON sarcastico...`);
  const news = await stepFormatta(raw, isPescara);

  console.log(`${label} — Step 3: notizia satirica...`);
  const satira   = await stepSatira(isPescara);
  const allNews  = [...news, satira];

  // 21 SVG — il rate limiter si occupa automaticamente delle pause ogni 10 chiamate
  console.log(`${label} — Step 4: genero ${allNews.length} illustrazioni SVG...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    process.stdout.write(`  [${i+1}/${allNews.length}] "${item.titolo.slice(0,40)}"... `);
    item.svg = await stepSVG(item.titolo, item.sommario, item.isFake);
    console.log(item.svg ? "✓" : "✗");
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────
async function main() {
  console.log("🐬 La Voce del Delfino — Gemini Edition");
  console.log(`📅 ${today}`);
  console.log("📊 Rate limiter: pausa automatica 2min ogni 10 chiamate\n");

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
  }

  fs.writeFileSync(
    path.join(DATA_DIR, "meta.json"),
    JSON.stringify({ lastUpdate: new Date().toISOString(), errors }, null, 2)
  );

  if (errors.length === 2) process.exit(1);
  console.log("\n🎉 Completato!");
}

main().catch(e => { console.error(e); process.exit(1); });
