import { caricaJSON, salvaJSON, contaArticoli, scriviLog } from "./utils.js";
import fs from "fs";

export async function caricaDraft(draftPath, oggiStr, agenda, IMPOSTAZIONI, STILI, logFn) {
    let oldDraft = fs.existsSync(draftPath) ? caricaJSON(draftPath, null) : null;
    const isNuovoGiorno = !oldDraft || oldDraft.dataRiferimento !== oggiStr;
    let draft;
    if (isNuovoGiorno) {
        draft = { dataRiferimento: oggiStr, oraAggiornamento: null, agenda, impostazioni: IMPOSTAZIONI, stili: STILI, sezioni: {} };
        logFn(`🆕 Nuovo draft per ${oggiStr}`);
    } else {
        draft = JSON.parse(JSON.stringify(oldDraft));
        logFn(`📰 Accumulo su ${contaArticoli(draft)} articoli esistenti`);
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

export async function safeWriteDraft(draft, draftPath, tempPath, backupPath, logFn) {
    const totale = contaArticoli(draft);
    if (totale === 0) {
        logFn("⚠️ Draft vuoto → NON sovrascrivo.");
        return false;
    }
    try {
        salvaJSON(tempPath, draft);
        if (fs.existsSync(draftPath)) fs.copyFileSync(draftPath, backupPath);
        fs.renameSync(tempPath, draftPath);
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        logFn(`💾 Draft salvato in modo sicuro (${totale} articoli).`);
        return true;
    } catch (e) {
        logFn(`❌ Errore scrittura draft: ${e.message}`);
        if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, draftPath);
        return false;
    }
}