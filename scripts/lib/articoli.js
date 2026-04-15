import { parseJSON, risolviPersonaggio } from "./utils.js";

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
    const raw = await callLLMFn(sys, userPrompt, voce.weight_articolo ?? 0.8);
    return parseJSON(raw);
}

export async function generaCommenti(voce, CHI, relazioni, personaggi, articolo, commentiPrecedenti, LIMITI, callLLMFn, logFn) {
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
    const raw = await callLLMFn(sys, userPrompt, voce.weight_commento ?? 0.7);
    const parsed = parseJSON(raw);
    return parsed?.commenti || [];
}