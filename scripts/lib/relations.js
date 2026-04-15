// lib/relations.js
import { labelDaScore } from "./utils.js";

let logFn = null;
const log = (msg) => logFn("[relations] " + msg);

export function initRelations(logFunction) {
    logFn = logFunction;
}

export function applicaDecay(relazioni) {
    const DECAY_OGNI_N_RUN = 14;
    const DECAY_AMOUNT = 0.1;
    relazioni._runCount = (relazioni._runCount || 0) + 1;
    if (relazioni._runCount >= DECAY_OGNI_N_RUN) {
        relazioni._runCount = 0;
        for (const chiave of Object.keys(relazioni)) {
            if (chiave.startsWith("_")) continue;
            const r = relazioni[chiave];
            if (typeof r.score === "number") {
                r.score = parseFloat((r.score * (1 - DECAY_AMOUNT)).toFixed(3));
                r.label = labelDaScore(r.score);
            }
        }
        log("📉 Decay settimanale relazioni applicato.");
    }
    return relazioni;
}

export async function aggiornaRelazioni(CHI, relazioni, personaggi, articolo, commenti, callLLMFn) {
    if (!commenti?.length) return;
    const sys = `Analista dinamiche sociali. Restituisci JSON: {"delta_relazioni":[{"da":"...","a":"...","delta":0.1}],"nuovi_stati":[{"nome":"...","stato":"...","umore":"..."}]}
Delta da -0.3 a +0.3.`;
    const userPrompt = `Articolo: "${articolo.substring(0,300)}..."\nCommenti:\n${commenti.map(c=>`${c.nome}: "${c.testo}"`).join("\n")}`;
    const { text: raw } = await callLLMFn(sys, userPrompt);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}")+1));
        for (const d of (parsed.delta_relazioni || [])) {
            const key = `${d.da}→${d.a}`;
            if (!relazioni[key]) relazioni[key] = { score:0, label:"neutro", ultimo_aggiornamento:"" };
            let newScore = Math.max(-1, Math.min(1, (relazioni[key].score||0) + d.delta));
            relazioni[key].score = Math.round(newScore * 1000)/1000;
            relazioni[key].label = labelDaScore(relazioni[key].score);
            relazioni[key].ultimo_aggiornamento = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome"});
        }
        for (const s of (parsed.nuovi_stati || [])) {
            if (!personaggi[s.nome]) personaggi[s.nome] = {};
            personaggi[s.nome].stato = s.stato;
            personaggi[s.nome].umore = s.umore;
            personaggi[s.nome].dal = new Date().toLocaleDateString("it-IT",{timeZone:"Europe/Rome"});
        }
        log(`🔄 Relazioni: ${parsed.delta_relazioni?.length || 0} delta, ${parsed.nuovi_stati?.length || 0} stati.`);
    } catch(e) { log(`[WARN] Parse relazioni: ${e.message}`); }
}
