let logFn = null;
const log = (msg) => logFn("[chat] " + msg);

export function initChat(logFunction) {
    logFn = logFunction;
}

export async function generaChat(CHI, relazioni, personaggi, callLLMFn) {
    const nomi = Object.keys(CHI).filter(n=>n!=="default");
    if (nomi.length<2) return null;
    const contestoRelazioni = nomi.flatMap(a=>nomi.filter(b=>b!==a).map(b=>{
        const r = relazioni[`${a}→${b}`];
        return r ? `${a} è ${r.label} verso ${b}` : null;
    }).filter(Boolean)).join(". ");
    const contestoStati = nomi.map(n=>{
        const p = personaggi[n];
        return p?.stato && p.stato!=="normale" ? `${n}: ${p.stato} (umore: ${p.umore||"neutro"})` : null;
    }).filter(Boolean).join(". ");
    const spunti = ["lamentele sul caffè","battibecco su un articolo","elogi ironici","discussione sul carico di lavoro","annuncio pausa"];
    const spunto = spunti[Math.floor(Math.random()*spunti.length)];
    const sys = `Narratore chat redazione. Personaggi: ${nomi.map(n=>`${n} (${CHI[n].avatar}, carattere: "${CHI[n].mood}")`).join(", ")}.
Relazioni: ${contestoRelazioni||"nessuna"}. Stati: ${contestoStati||"normali"}.
Spunto: ${spunto}. Genera chat 4-8 messaggi tra 2-3 personaggi.
Rispondi JSON: {"chat":[{"nome":"...","avatar":"...","testo":"..."}]}`;
    const { text: raw } = await callLLMFn(sys, "Genera chat.");
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}")+1));
        return parsed.chat || null;
    } catch(e) { return null; }
}
