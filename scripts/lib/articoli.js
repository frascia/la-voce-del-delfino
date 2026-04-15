/**
 * FILE: lib/articoli.js
 * DATA: 2025-04-15
 * VERSIONE: 2.2
 * DESCRIZIONE: Generazione degli articoli e dei commenti tramite LLM.
 *              Log dettagliati con esito e lunghezza.
 */

import { parseJSON, risolviPersonaggio } from "./utils.js";

let logFn = null;
const log = (msg) => logFn("[articoli] " + msg);

export function initArticoli(logFunction) {
    logFn = logFunction;
}

export async function generaArticolo(voce, CHI, titolo, callLLMFn) {
    const firma = risolviPersonaggio(CHI, voce.firma);
    const moodFirma = firma.mood || "neutro";
    const bioFirma = (firma.bio_breve || firma.bio) ? `La tua storia: "${firma.bio_breve || firma.bio}".` : "";
    const moodCommento = voce.mood ? `Il tono del commento finale deve essere: ${voce.mood}` : "";
    const isGenerato = voce.tipo === "GEN";
    const puoInventare = voce.fantasia === true;
    
    const sys = `Sei ${voce.firma}, giornalista con carattere: "${moodFirma}". ${bioFirma}
Rispondi con JSON: {"titolo":"...","articolo":"...","commento":"..."}.
Articolo di ~${voce._parole || 400} parole.
${puoInventare ? "Puoi inventare liberamente." : "Scrivi cose reali, senza inventare fatti falsi."}
Nessun riferimento temporale specifico (oggi, ieri, ecc.).
${moodCommento}`;
    
    const userPrompt = isGenerato ? `Scrivi un articolo su: ${titolo}` : `Notizia reale: ${titolo}. Scrivi un articolo.`;
    
    log(`🔄 Generazione articolo per ${voce.firma} (${voce.tipo})...`);
    
    const startTime = Date.now();
    const llmResult = await callLLMFn(sys, userPrompt, voce.weight_articolo ?? 0.8);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (!llmResult) {
        log(`❌ ${voce.firma}: generazione fallita (${elapsed}s)`);
        return null;
    }
    
    const { provider, text } = llmResult;
    const parsed = parseJSON(text);
    
    if (!parsed?.articolo || parsed.articolo.length < 50) {
        log(`⚠️ ${voce.firma} (${provider}): output non valido (${parsed?.articolo?.length || 0} caratteri) – ${elapsed}s`);
        return null;
    }
    
    log(`✅ ${voce.firma} (${provider}): "${parsed.titolo?.substring(0, 40) || titolo.substring(0, 40)}..." – ${parsed.articolo.length} caratteri (${elapsed}s)`);
    
    return { ...parsed, provider };
}

export async function generaCommenti(voce, CHI, relazioni, personaggi, articolo, commentiPrecedenti, LIMITI, callLLMFn) {
    const nomi = Object.keys(CHI).filter(n => n !== "default");
    const contestoRelazioni = nomi.flatMap(a => nomi.filter(b=>b!==a).map(b=>{
        const r = relazioni[`${a}→${b}`];
        return r ? `${a} è ${r.label} verso ${b} (score: ${r.score})` : null;
    }).filter(Boolean)).join(". ");
    const contestoStati = nomi.map(n=>{
        const p = personaggi[n];
        return p?.stato && p.stato!=="normale" ? `${n} è: ${p.stato} (umore: ${p.umore||"neutro"})` : null;
    }).filter(Boolean).join(". ");
    const contestoCommenti = commentiPrecedenti?.length ? `Commenti precedenti:\n${commentiPrecedenti.map(c=>`${c.nome} (${c.avatar}): "${c.testo}"`).join("\n")}` : "";
    
    const sys = `Sei il moderatore. Personaggi: ${nomi.map(n=>`${n} (${CHI[n].avatar}, mood: "${CHI[n].mood}")`).join(", ")}.
Relazioni: ${contestoRelazioni || "nessuna"}.
Stati: ${contestoStati || "normali"}.
${contestoCommenti}
Scegli da ${LIMITI.commenti_min??1} a ${LIMITI.commenti_max??3} personaggi che commentano notizia e commenti precedenti.
Il personaggio "${voce.firma}" non può commentare se stesso.
Rispondi solo JSON: {"commenti":[{"nome":"...","avatar":"...","testo":"..."}]}`;
    
    const userPrompt = `Articolo: "${articolo}"\nGenera commenti.`;
    const llmResult = await callLLMFn(sys, userPrompt, voce.weight_commento ?? 0.7);
    if (!llmResult) {
        log(`⚠️ Commenti per "${voce.firma}": nessuna generazione`);
        return [];
    }
    const { text } = llmResult;
    const parsed = parseJSON(text);
    const numCommenti = parsed?.commenti?.length || 0;
    if (numCommenti > 0) {
        log(`💬 ${voce.firma}: generati ${numCommenti} commenti`);
    }
    return parsed?.commenti || [];
}
