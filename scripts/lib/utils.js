import fs from "fs";

export function scriviLog(msg, logPath) {
    const ts = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    const riga = `[${ts}] [1-fetch-v2] ${msg}\n`;
    fs.appendFileSync(logPath, riga);
    console.log(`> ${msg}`);
}

export function caricaJSON(filePath, defaultVal) {
    try {
        if (fs.existsSync(filePath))
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) { /* silenzioso */ }
    return defaultVal;
}

export function salvaJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function contaArticoli(draft) {
    return Object.values(draft.sezioni || {})
        .reduce((acc, s) => acc + (s.articoli?.length || 0), 0);
}

export function parseJSON(raw) {
    if (!raw) return null;
    try {
        let start = raw.indexOf("{"), end = raw.lastIndexOf("}");
        if (start !== -1 && end !== -1) return JSON.parse(raw.substring(start, end+1));
        start = raw.indexOf("["); end = raw.lastIndexOf("]");
        if (start !== -1 && end !== -1) {
            const arr = JSON.parse(raw.substring(start, end+1));
            return arr[0] || null;
        }
    } catch(e) {}
    return null;
}

export function labelDaScore(score) {
    if (score >= 0.7)  return "amico";
    if (score >= 0.3)  return "simpatico";
    if (score >= -0.2) return "neutro";
    if (score >= -0.6) return "diffidente";
    return "ostile";
}

export function giornoOggi() {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
    return ["dom","lun","mar","mer","gio","ven","sab"][d.getDay()];
}

export function risolviAgenda(AGENDA, oggi) {
    for (const [k, v] of Object.entries(AGENDA)) {
        if (k === "default") continue;
        if (k.split(",").map(s=>s.trim()).includes(oggi)) return { ...AGENDA.default, ...v };
    }
    return AGENDA.default;
}

export function risolviPersonaggio(CHI, nome) {
    return CHI[nome] || CHI["default"] || { mood: "neutro", peso: 0.5, avatar: "🐬", img: "default_personaggio.webp" };
}

export const ATTESA_GEMINI_MS = 1500;
export async function pausaGemini() {
    await new Promise(r => setTimeout(r, ATTESA_GEMINI_MS));
}

export async function gestisciErroreQuota(msg, scriviLogFn) {
    const m = msg.match(/Please retry in ([\d.]+)s/);
    const sec = m ? parseFloat(m[1]) + 2 : 30;
    scriviLogFn(`⏳ Attendo ${sec.toFixed(1)}s...`);
    await new Promise(r => setTimeout(r, sec * 1000));
}

export function caricaContatori(contatoriPath, LIMITI, scriviLogFn) {
    const oraRoma = new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Rome"}));
    const oggi = oraRoma.toLocaleDateString("it-IT",{day:"2-digit",month:"2-digit"});
    const ora = oraRoma.getHours(), min = oraRoma.getMinutes();
    const contatori = caricaJSON(contatoriPath, {});
    const fasciaReset = parseInt(LIMITI.fascia_reset_quote ?? "05");
    const tolleranza = LIMITI.tolleranza_minuti ?? 30;
    const inFasciaReset = Math.abs(ora*60+min - fasciaReset*60) <= tolleranza;
    const deveResettare = contatori.data !== oggi || (inFasciaReset && !contatori.reset_eseguito_oggi);
    if (deveResettare) {
        scriviLogFn(`🔄 Reset quote (${oggi} ${String(ora).padStart(2,"0")}:${String(min).padStart(2,"0")})`);
        return {
            data: oggi, reset_eseguito_oggi: inFasciaReset, _primoRunOggi: false,
            cerca_modello:0, chat_run:0, chiamate_gemini:0, token_stimati:0, rss_fetch:0, articoli_run:0,
            chiamate_gemini_totali: contatori.chiamate_gemini_totali || 0,
            token_stimati_totali: contatori.token_stimati_totali || 0
        };
    }
    return contatori;
}

export function limiteSuperato(contatori, LIMITI, tipo) {
    const limite = LIMITI[tipo];
    if (!limite || limite==="sempre") return false;
    return (contatori[tipo.replace("_max","")] || 0) >= limite;
}

export function fasciaDiArticoliAttiva(LIMITI) {
    const fasce = LIMITI.fasce_articoli;
    if (!fasce?.length) return true;
    const oraRoma = new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Rome"}));
    const minuti = oraRoma.getHours()*60 + oraRoma.getMinutes();
    const tolleranza = LIMITI.tolleranza_minuti ?? 30;
    return fasce.some(f => Math.abs(minuti - parseInt(f)*60) <= tolleranza);
}

export function paroleTarget(LIMITI) {
    const livello = Math.max(1, Math.min(10, LIMITI.lunghezza_articolo ?? 5));
    return Math.round(80 + (livello-1)*80);
}
