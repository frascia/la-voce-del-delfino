/**
 * FILE: lib/llm.js
 * DATA: 2025-04-15
 * VERSIONE: 2.8
 * DESCRIZIONE: Gestione chiamate LLM (Gemini/Groq), provider persistente,
 *              contatore fallimenti consecutivi, modalità scheduled/manuale.
 *              Supporto per forzare un modello Gemini specifico e versione API.
 */

import { pausaGemini, gestisciErroreQuota, caricaJSON, salvaJSON } from "./utils.js";

let logFn = null;
let apiKeyGemini = "", apiKeyGroq = "";
let groqModelCorrente = "llama3-70b-8192";
let groqMaxTokens = 1024;
let ricercaEffettuata = false;
let currentProvider = "gemini";
let quotaLogSent = false;
let providerStatePath = "";
let activeGeminiModel = "gemini-1.5-flash";
let isScheduledRun = false;
let consecutiveFailures = 0;
let failuresThreshold = parseInt(process.env.RUN_FAILURES_THRESHOLD || "3");

// Variabili configurabili da ambiente
const FORCED_GEMINI_MODEL = process.env.FORCED_GEMINI_MODEL || "";
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1";

const log = (msg) => logFn("[llm] " + msg);

export function initLLM(geminiKey, groqKey, providerStateFile, logFunction) {
    apiKeyGemini = geminiKey;
    apiKeyGroq = groqKey;
    providerStatePath = providerStateFile;
    logFn = logFunction;
    const saved = caricaJSON(providerStatePath, { provider: "gemini", consecutiveFailures: 0 });
    currentProvider = saved.provider;
    consecutiveFailures = saved.consecutiveFailures || 0;
    log(`⚙️ Provider inizializzato: ${currentProvider} | Fallimenti consecutivi: ${consecutiveFailures}`);
    log(`🔧 API Gemini versione: ${GEMINI_API_VERSION}`);
    
    if (FORCED_GEMINI_MODEL) {
        activeGeminiModel = FORCED_GEMINI_MODEL;
        log(`🔒 Modello Gemini forzato da ambiente: ${activeGeminiModel}`);
    }
}

function salvaStatoProvider() {
    salvaJSON(providerStatePath, { provider: currentProvider, consecutiveFailures });
}

export function setScheduledRun(scheduled) {
    isScheduledRun = scheduled;
    log(`📌 Run ${scheduled ? "SCHEDULATO" : "MANUALE"} – i fallimenti ${scheduled ? "verranno" : "NON verranno"} conteggiati`);
    if (!isScheduledRun) {
        if (currentProvider !== "gemini") {
            log(`🔁 Run manuale: forzato provider a GEMINI (ignoro contatore fallimenti)`);
            currentProvider = "gemini";
        }
    } else {
        if (consecutiveFailures >= failuresThreshold && currentProvider === "gemini") {
            log(`⚠️ Soglia raggiunta (${consecutiveFailures}/${failuresThreshold}) → passaggio a GROQ`);
            currentProvider = "groq";
        }
    }
}

export function incrementConsecutiveFailures() {
    if (!isScheduledRun) {
        log(`⏭️ Run manuale: fallimenti NON incrementati`);
        return;
    }
    consecutiveFailures++;
    log(`📊 Fallimenti consecutivi: ${consecutiveFailures} (soglia: ${failuresThreshold})`);
    salvaStatoProvider();
}

export function resetConsecutiveFailures() {
    if (!isScheduledRun) {
        log(`⏭️ Run manuale: reset fallimenti NON eseguito`);
        return;
    }
    if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        log(`✅ Reset fallimenti consecutivi (Gemini ha prodotto articoli)`);
        salvaStatoProvider();
    }
}

export function getCurrentProvider() {
    return currentProvider;
}

export function setActiveGeminiModel(model) {
    if (!FORCED_GEMINI_MODEL) {
        activeGeminiModel = model;
        log(`🎯 Modello Gemini impostato a: ${activeGeminiModel}`);
    } else {
        log(`⚠️ Modello forzato da ambiente (${FORCED_GEMINI_MODEL}), ignoro richiesta di cambio a ${model}`);
    }
}

async function testaModelloGemini(modelName) {
    const url = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${modelName}:generateContent?key=${apiKeyGemini}`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Rispondi solo con la parola 'ok'" }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 5 }
            })
        });
        const d = await res.json();
        return d.candidates?.length > 0;
    } catch(e) {
        return false;
    }
}

async function trovaModelliGemini() {
    if (FORCED_GEMINI_MODEL) {
        log(`🔒 Ricerca modelli saltata (modello forzato: ${FORCED_GEMINI_MODEL})`);
        return;
    }
    
    if (!apiKeyGemini) return;
    try {
        const url = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models?key=${apiKeyGemini}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.models) {
            const tutti = data.models
                .filter(m => m.name.includes("gemini") && 
                             m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            
            const senzaPro = tutti.filter(m => !m.includes("pro"));
            const flash = senzaPro.filter(m => m.includes("flash"));
            const altri = senzaPro.filter(m => !m.includes("flash"));
            
            log(`🤖 Modelli Gemini disponibili (gratuiti):`);
            if (flash.length) log(`   ├─ Flash: ${flash.join(", ")}`);
            if (altri.length) log(`   └─ Altri: ${altri.join(", ")}`);
            
            const ordine = [...flash.sort((a,b)=>b.localeCompare(a)), ...altri];
            let modelloFunzionante = null;
            
            for (const model of ordine.slice(0, 5)) {
                log(`   🔍 Test ${model}...`);
                const funziona = await testaModelloGemini(model);
                if (funziona) {
                    modelloFunzionante = model;
                    log(`   ✅ ${model} funzionante`);
                    break;
                } else {
                    log(`   ❌ ${model} non risponde`);
                }
            }
            
            if (modelloFunzionante) {
                activeGeminiModel = modelloFunzionante;
                log(`🎯 Modello Gemini selezionato: ${activeGeminiModel}`);
            } else if (senzaPro.length > 0) {
                activeGeminiModel = senzaPro[0];
                log(`⚠️ Nessun modello testato funziona, uso default: ${activeGeminiModel}`);
            }
        }
    } catch(e) {
        log(`⚠️ Ricerca modelli Gemini fallita: ${e.message}`);
    }
}

async function trovaUltimoModelloGroq() {
    if (!apiKeyGroq) return;
    const url = "https://api.groq.com/openai/v1/models";
    try {
        const res = await fetch(url, { headers: { "Authorization": `Bearer ${apiKeyGroq}` } });
        if (!res.ok) return;
        const data = await res.json();
        const testuali = data.data.filter(m => 
            m.id && (m.id.includes("llama") || m.id.includes("mixtral") || m.id.includes("gemma")) &&
            !m.id.includes("embed") && !m.id.includes("guard") && !m.id.includes("safety")
        );
        if (!testuali.length) return;
        const migliori = testuali.filter(m => m.id.includes("llama"));
        const daOrdinare = migliori.length ? migliori : testuali;
        daOrdinare.sort((a,b)=> (b.created||0) - (a.created||0));
        const migliore = daOrdinare[0].id;
        if (migliore !== groqModelCorrente) {
            log(`🤖 Groq: modello aggiornato → ${migliore} (era ${groqModelCorrente})`);
            groqModelCorrente = migliore;
        }
        if (groqModelCorrente.includes("gemma")) groqMaxTokens = 512;
        else if (groqModelCorrente.includes("llama3-70b")) groqMaxTokens = 2000;
        else if (groqModelCorrente.includes("llama3-8b")) groqMaxTokens = 1024;
        else if (groqModelCorrente.includes("mixtral")) groqMaxTokens = 2000;
        else groqMaxTokens = 1024;
        log(`🤖 Groq: max_tokens=${groqMaxTokens} per ${groqModelCorrente}`);
    } catch(e) { log(`⚠️ Ricerca modelli Groq fallita: ${e.message}`); }
}

async function callGemini(sys, prompt, temperature) {
    if (!apiKeyGemini) return null;
    const url = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${activeGeminiModel}:generateContent?key=${apiKeyGemini}`;
    for (let i=0; i<3; i++) {
        await pausaGemini();
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] },
                    generationConfig: { responseMimeType: "application/json", temperature },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });
            const d = await res.json();
            if (d.error) {
                const msg = (d.error.message || "").toLowerCase();
                if (msg.includes("limit") && msg.includes("per day")) {
                    if (!quotaLogSent) {
                        log(`⚠️ Gemini: quota giornaliera esaurita (429)`);
                        quotaLogSent = true;
                    }
                    return null;
                }
                if (d.error.code === 429 || d.error.code === 503) {
                    if (msg.includes("quota exceeded")) {
                        if (!quotaLogSent) log(`⏳ Gemini: quota exceeded, attendo...`);
                        quotaLogSent = true;
                        await gestisciErroreQuota(d.error.message, log);
                        continue;
                    }
                    const ms = Math.pow(2,i) * 10000;
                    log(`⏳ Gemini: errore ${d.error.code} (tentativo ${i+1}/3) – ritento tra ${ms/1000}s`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                if (!msg.includes("quota")) log(`❌ Gemini: ${d.error.message} (code: ${d.error.code})`);
                return null;
            }
            if (d.candidates?.length) return d.candidates[0].content.parts[0].text;
            return null;
        } catch(e) {
            log(`❌ Gemini: errore rete - ${e.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return null;
}

async function callGroq(sys, prompt, temperature) {
    if (!apiKeyGroq) return null;
    if (!ricercaEffettuata) {
        await trovaUltimoModelloGroq();
        ricercaEffettuata = true;
    }
    const MAX_SYS = 6000;
    const MAX_PROMPT = 15000;
    let finalSys = sys.length > MAX_SYS ? sys.substring(0, MAX_SYS) + "... [troncato]" : sys;
    let finalPrompt = prompt.length > MAX_PROMPT ? prompt.substring(0, MAX_PROMPT) + "... [troncato]" : prompt;
    
    if (sys.length > MAX_SYS) log(`⚠️ Groq: system message troncato (${sys.length} → ${MAX_SYS} caratteri)`);
    
    let messages = [{ role: "system", content: finalSys }, { role: "user", content: finalPrompt }];
    let currentMax = groqMaxTokens;
    const url = "https://api.groq.com/openai/v1/chat/completions";
    for (let i=0; i<3; i++) {
        await pausaGemini();
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKeyGroq}` },
                body: JSON.stringify({ model: groqModelCorrente, messages, temperature, max_tokens: currentMax, response_format: { type: "json_object" } })
            });
            const d = await res.json();
            if (!res.ok || d.error) {
                const msg = (d.error?.message || "").toLowerCase();
                if (d.error?.code === 400 && msg.includes("single user message")) {
                    log(`🔄 Groq: modello richiede un solo messaggio, unisco system+user`);
                    messages = [{ role: "user", content: finalSys + "\n\n" + finalPrompt }];
                    continue;
                }
                log(`❌ Groq: ${d.error?.message || res.status} (code: ${d.error?.code || res.status})`);
                if (msg.includes("limit") || d.error?.code === 429) {
                    log(`⚠️ Groq: quota esaurita (429)`);
                    return null;
                }
                if (d.error?.code === 400 && (msg.includes("max_tokens") || msg.includes("context_window"))) {
                    if (currentMax > 128) {
                        currentMax = Math.max(128, Math.floor(currentMax*0.6));
                        log(`🔄 Groq: riduzione max_tokens a ${currentMax}`);
                        continue;
                    }
                    return null;
                }
                if (d.error?.code === 400 && msg.includes("reduce the length")) {
                    finalPrompt = finalPrompt.substring(0, Math.floor(finalPrompt.length*0.6)) + "... [troncato 2]";
                    if (messages.length===1) messages[0].content = finalSys + "\n\n" + finalPrompt;
                    else messages[1].content = finalPrompt;
                    log(`🔄 Groq: prompt ridotto a ${finalPrompt.length} caratteri`);
                    continue;
                }
                if ([429,503,500].includes(d.error?.code)) {
                    const ms = Math.pow(2,i) * 10000;
                    log(`⏳ Groq: errore ${d.error.code} (tentativo ${i+1}/3) – ritento tra ${ms/1000}s`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                return null;
            }
            const content = d.choices?.[0]?.message?.content;
            if (!content) return null;
            let jsonText = content.trim().replace(/^```json\s*/, "").replace(/```$/, "");
            JSON.parse(jsonText);
            return jsonText;
        } catch(e) {
            log(`❌ Groq: errore rete - ${e.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return null;
}

export async function callLLM(sys, prompt, temperature = 0.85) {
    const tryProvider = async (provider) => {
        const text = provider === "groq" ? await callGroq(sys, prompt, temperature) : await callGemini(sys, prompt, temperature);
        return { provider, text };
    };
    
    let { provider, text: result } = await tryProvider(currentProvider);
    
    function isValido(jsonStr) {
        if (!jsonStr) return false;
        try {
            const obj = JSON.parse(jsonStr);
            if (obj.articolo && obj.articolo.length > 50 && !obj.articolo.includes("contenuto non generato")) {
                return true;
            }
        } catch(e) {}
        return false;
    }
    
    if (isValido(result)) {
        log(`✅ Generazione riuscita (${provider})`);
        return { provider, text: result };
    }
    
    log(`⚠️ ${provider}: nessun output valido, salto generazione`);
    return null;
}

export async function initModels() {
    if (FORCED_GEMINI_MODEL) {
        log(`🔒 Ricerca modelli Gemini saltata (modello forzato: ${FORCED_GEMINI_MODEL})`);
    } else {
        await trovaModelliGemini();
    }
    if (apiKeyGroq) await trovaUltimoModelloGroq();
}