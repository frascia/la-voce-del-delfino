// lib/draft.js
import { caricaJSON, salvaJSON, contaArticoli } from "./utils.js";
import fs from "fs";

let logFn = null;
const log = (msg) => logFn("[draft] " + msg);

export function initDraft(logFunction) {
    logFn = logFunction;
}

export async function caricaDraft(draftPath, oggiStr, agenda, IMPOSTAZIONI, STILI) {
    let oldDraft = fs.existsSync(draftPath) ? caricaJSON(draftPath, null) : null;
    const isNuovoGiorno = !oldDraft || oldDraft.dataRiferimento !== oggiStr;
    let draft;
    if (isNuovoGiorno) {
        draft = { dataRiferimento: oggiStr, oraAggiornamento: null, agenda, impostazioni: IMPOSTAZIONI, stili: STILI, sezioni: {} };
        log(`🆕 Nuovo draft per ${oggiStr}`);
    } else {
        draft = JSON.parse(JSON.stringify(oldDraft));
        log(`📰 Accumulo su ${contaArticoli(draft)} articoli esistenti`);
    }
    return { draft, isNuovoGiorno, oldDraft };
}

export function inizializzaSezioni(draft, vociAttive, STILI) {
    for (const voce of vociAttive) {
        const sez = voce.sez;
        if (!draft.sezioni[sez]) {
            draft.sezioni[sez] = { color: STILI[sez] || STILI["RSS"] || "#005f73", articoli: [] };
        }
    }
}

export async function safeWriteDraft(draft, draftPath, tempPath, backupPath) {
    const totale = contaArticoli(draft);
    if (totale === 0) {
        log("⚠️ Draft vuoto → NON sovrascrivo.");
        return false;
    }
    try {
        salvaJSON(tempPath, draft);
        if (fs.existsSync(draftPath)) fs.copyFileSync(draftPath, backupPath);
        fs.renameSync(tempPath, draftPath);
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        log(`💾 Draft salvato in modo sicuro (${totale} articoli).`);
        return true;
    } catch (e) {
        log(`❌ Errore scrittura draft: ${e.message}`);
        if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, draftPath);
        return false;
    }
}
