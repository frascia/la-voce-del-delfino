#!/usr/bin/env node
/**
 * fetch-news.js — La Voce del Delfino
 * Usa Google Gemini API (gratuita con tier free)
 * Modello: gemini-2.0-flash  (supporta Google Search nativo)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "../public/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("❌ GEMINI_API_KEY mancante"); process.exit(1); }

// gemini-2.0-flash: gratuito, veloce, supporta Google Search grounding
const MODEL_FAST = "gemini-2.0-flash";
// gemini-2.5-pro: più creativo per SVG (opzionale, usa flash se vuoi risparmiare)
const MODEL_SVG  = "gemini-2.0-flash";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const today = new Date().toLocaleDateString("it-IT", {
  weekday:"long", year:"numeric", month:"long", day:"numeric"
});

// ─────────────────────────────────────────────
//  Gemini API helper
// ─────────────────────────────────────────────
async function callGemini(model, { system, prompt, useSearch = false, maxTokens = 4096 }) {
  const body = {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.9,
    }
  };

  // Google Search grounding — permette al modello di cercare notizie reali
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }

  // Rimuovi system_instruction se undefined
  if (!body.system_instruction) delete body.system_instruction;

  const url = `${BASE_URL}/models/${model}:generateContent?key=${API_KEY}`;
  const res  = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();

  // Estrai testo dalla risposta Gemini
  const text = data.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "")
    .join("") ?? "";

  if (!text) throw new Error("Risposta vuota da Gemini");
  return text;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function extractJSON(text) {
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const si = clean.indexOf("["), ei = clean.lastIndexOf("]");
  if (si !== -1 && ei > si) {
    const c = clean.slice(si, ei + 1);
    try { return JSON.parse(c); } catch {}
    try { return JSON.parse(c.replace(/,\s*([}\]])/g, "$1").replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  }
  const si2 = clean.indexOf("{"), ei2 = clean.lastIndexOf("}");
  if (si2 !== -1 && ei2 > si2) {
    try { return [JSON.parse(clean.slice(si2, ei2 + 1))]; } catch {}
  }
  throw new Error("JSON non trovato");
}

function extractSVG(text) {
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  return m[0].replace(/<svg([^>]*)>/, (_, attrs) => {
    const withVB = attrs.includes("viewBox") ? attrs : attrs + ' viewBox="0 0 900 400"';
    const clean  = withVB.replace(/width="[^"]*"/, "").replace(/height="[^"]*"/, "");
    return `<svg${clean} style="width:100%;height:100%;display:block;">`;
  });
}

// ─────────────────────────────────────────────
//  Illustrazione SVG Ghibli
// ─────────────────────────────────────────────
async function generateIllustration(titolo, sommario, isFake) {
  try {
    const svg = await callGemini(MODEL_SVG, {
      maxTokens: 2000,
      system: `Sei un artista dello Studio Ghibli. Crea illustrazioni SVG acquerello che rappresentano VISIVAMENTE la scena specifica della notizia.

REGOLE DI INTERPRETAZIONE (obbligatorie — non creare paesaggi generici):
- Calcio/sport → campo verde, figure umane stilizzate che giocano, pallone in volo, stadio sullo sfondo
- Proteste/manifestazioni → folla colorata con cartelli, piazza affollata, edificio governativo
- Spazio/astronomia → pianeta specifico colorato con anelli, stelle dense, sonda spaziale
- Animale raro → quell'animale specifico nel suo habitat naturale con dettagli caratteristici
- Incendio/disastro → fiamme arancioni e rosse, fumo scuro, alberi bruciati, pompieri stilizzati
- Festival/musica → palco illuminato, folla festante, strumenti musicali specifici, lanterne
- Elezioni/politica → urne, bandiere colorate, palazzo parlamentare, folla in piazza
- Medicina/scienza → laboratorio con microscopi, provette luminose, scienziati in camice
- Mare/oceano → onde dettagliate blu-verde, barche, pesci colorati, faro lontano
- Cibo/gastronomia → tavola imbandita, vapore da piatti caldi, ingredienti, cucina vivace
- Tecnologia/AI → robot stilizzato Ghibli, schermi luminosi, città futuristica
- Ambiente/foresta → paesaggio verde specifico, fauna e flora ricca, ruscello

STILE: acquerello Ghibli — colori pastello morbidi, tratti delicati, atmosfera poetica e sognante.
DIMENSIONI: viewBox="0 0 900 400"
RISPOSTA: SOLO il codice SVG completo. Inizia con <svg, finisci con </svg>.
Usa solo elementi SVG nativi: rect, circle, ellipse, path, polygon, line, text, g, defs, linearGradient, radialGradient, filter.`,
      prompt: `Notizia: "${titolo}"\nDettaglio: ${sommario}${isFake ? "\n(È una notizia satirica e assurda — puoi essere creativo e umoristico)" : ""}\n\nDisegna la scena SVG Ghibli che rappresenta questa notizia.`
    });
    return extractSVG(svg);
  } catch(e) {
    console.warn(`  ⚠️  SVG fallito: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  Notizia satirica
// ─────────────────────────────────────────────
async function generateSatira(isPescara) {
  const txt = await callGemini(MODEL_FAST, {
    maxTokens: 600,
    system: `Sei un satirico italiano geniale. Inventa una notizia FALSA, assurda ma plausibile, sempre originale e diversa.
Rispondi SOLO con JSON puro. Zero testo extra. Zero backtick.
Chiavi obbligatorie: titolo, categoria, sommario, commento, luogo`,
    prompt: isPescara
      ? `Inventa UNA notizia satirica nuova e originale su Pescara o l'Abruzzo. Temi: comune, spiaggia, arrosticini, traffico, turisti, sagre, delfino-mascotte, locali notturni, mare d'inverno, pescaresi DOC. Sii assurdo e feroce. JSON: {"titolo":"...","categoria":"Cronaca Locale","sommario":"2-3 frasi comiche","commento":"battuta finale feroce e irresistibile","luogo":"zona di Pescara"}`
      : `Inventa UNA notizia satirica nuova e originale mondiale. Scegli un tema DIVERSO ogni volta: scienza folle, politici bizzarri, animali con comportamenti umani, tecnologia inutile, moda assurda, social media, AI, clima, diete, sport estremi, burocrazia kafkiana. JSON: {"titolo":"...","categoria":"Scienza|Tecnologia|Cultura|Cronaca|Ambiente|Sport","sommario":"2-3 frasi comiche","commento":"battuta finale feroce e irresistibile","luogo":"città, paese"}`
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
    isFake:    true,
    svg:       null
  };
}

// ─────────────────────────────────────────────
//  Pipeline principale per una sezione
// ─────────────────────────────────────────────
async function buildSection(isPescara) {
  const label = isPescara ? "🐬 PESCARA" : "🌍 MONDO";
  const cats  = isPescara
    ? "Mare & Spiaggia, Cultura Locale, Sport Locale, Città & Infrastrutture, Gastronomia, Ambiente, Cronaca, Eventi & Sagre, Economia Locale"
    : "Scienza, Natura, Salute, Tecnologia, Cultura, Animali, Spazio, Innovazione, Gastronomia, Sport, Economia, Ambiente";

  // STEP 1 — ricerca notizie con Google Search grounding
  console.log(`\n${label} — Step 1: ricerca notizie con Google Search...`);
  const rawNotizie = await callGemini(MODEL_FAST, {
    useSearch: true,
    maxTokens: 6000,
    prompt: isPescara
      ? `Cerca e descrivi 20 notizie recenti di Pescara e Abruzzo (oggi, ${today}). Temi: sport locale, cultura, gastronomia, cronaca positiva, economia, eventi, lungomare, infrastrutture, natura, turismo. Per ognuna: titolo, fonte, luogo preciso, descrizione dettagliata.`
      : `Oggi è ${today}. Trova 20 notizie recenti, positive o interessanti dal mondo. Temi vari: scienza, natura, spazio, animali, tecnologia, cultura, sport, gastronomia, economia, ambiente, salute. Per ognuna: titolo, paese/città, fonte, descrizione dettagliata.`
  });

  // STEP 2 — formatta in JSON sarcastico
  console.log(`${label} — Step 2: formatto 20 articoli sarcastici...`);
  const jsonTxt = await callGemini(MODEL_FAST, {
    maxTokens: 8000,
    system: `Sei un redattore italiano sarcastico e brillante — una via di mezzo tra Nanni Moretti e un comico da avanspettacolo.
Trasforma le notizie in JSON puro. ZERO backtick, ZERO testo prima o dopo l'array.
Array di ESATTAMENTE 20 oggetti con chiavi: titolo, categoria, sommario, commento, fonte, luogo.
Il campo "commento" DEVE essere sarcastico, ironico, divertente, con battuta finale obbligatoria. MAI serio o neutro.`,
    prompt: `Notizie trovate:\n\n${rawNotizie}\n\nTrasforma in JSON (array di 20 oggetti):\n[{"titolo":"titolo accattivante in italiano","categoria":"una di: ${cats}","sommario":"2-3 frasi che spiegano la notizia","commento":"commento sarcastico e divertente con battuta finale — mai serio","fonte":"nome della fonte","luogo":"${isPescara ? "quartiere o zona di Pescara" : "Paese o città"}"}]`
  });

  const parsed = extractJSON(jsonTxt);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Nessuna notizia ricevuta");

  const norm = parsed.slice(0, 20).map((x, i) => ({
    titolo:    x.titolo    || `Notizia ${i + 1}`,
    categoria: x.categoria || (isPescara ? "Pescara" : "Mondo"),
    sommario:  x.sommario  || "",
    commento:  x.commento  || "",
    fonte:     x.fonte     || "Fonte",
    luogo:     x.luogo     || (isPescara ? "Pescara" : "—"),
    isFake:    false,
    svg:       null
  }));

  // STEP 3 — satira
  console.log(`${label} — Step 3: notizia satirica...`);
  const satira  = await generateSatira(isPescara);
  const allNews = [...norm, satira];

  // STEP 4 — illustrazioni SVG in sequenza (rispetta rate limit free tier)
  console.log(`${label} — Step 4: genero ${allNews.length} illustrazioni SVG Ghibli...`);
  for (let i = 0; i < allNews.length; i++) {
    const item = allNews[i];
    process.stdout.write(`  [${i + 1}/${allNews.length}] "${item.titolo.slice(0, 45)}"... `);
    item.svg = await generateIllustration(item.titolo, item.sommario, item.isFake);
    console.log(item.svg ? "✓" : "✗ (fallita)");
    // Pausa per rispettare il rate limit del tier gratuito (15 req/min)
    if (i < allNews.length - 1) await new Promise(r => setTimeout(r, 4500));
  }

  return { generatedAt: new Date().toISOString(), today, news: allNews };
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────
async function main() {
  console.log("🐬 La Voce del Delfino — Gemini Edition");
  console.log(`📅 ${today}`);

  const errors = [];
  for (const isPescara of [false, true]) {
    try {
      const data  = await buildSection(isPescara);
      const fname = isPescara ? "news-pescara.json" : "news-mondo.json";
      fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(data, null, 2), "utf8");
      console.log(`\n✅ Salvato ${fname} (${data.news.length} articoli)`);
    } catch(e) {
      console.error(`\n❌ Errore ${isPescara ? "Pescara" : "Mondo"}: ${e.message}`);
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
