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
let failuresThreshold = parseInt(process.env.RUN_FAILURES_THRESHOLD || "2");

const log = (msg) => logFn("[llm] " + msg);

export function initLLM(geminiKey, groqKey, providerStateFile, logFunction) {
    apiKeyGemini = geminiKey;
    apiKeyGroq = groqKey;
    providerStatePath = providerStateFile;
    logFn = logFunction;
    const saved = caricaJSON(providerStatePath, { provider: "gemini", consecutiveFailures: 0 });
    currentProvider = saved.provider;
    consecutiveFailures = saved.consecutiveFailures || 0;
    log(`Provider inizializzato: ${currentProvider}, fallimenti consecutivi: ${consecutiveFailures}`);
}

function salvaStatoProvider() {
    salvaJSON(providerStatePath, { provider: currentProvider, consecutiveFailures });
}

export function setScheduledRun(scheduled) {
    isScheduledRun = scheduled;
    log(`Run ${scheduled ? "schedulato" : "manuale"} – i fallimenti ${scheduled ? "verranno" : "NON verranno"} conteggiati`);
    if (!isScheduledRun) {
        if (currentProvider !== "gemini") {
            log(`Run manuale: forzato provider a gemini (ignoro contatore fallimenti)`);
            currentProvider = "gemini";
        }
    } else {
        if (consecutiveFailures >= failuresThreshold && currentProvider === "gemini") {
            log(`Soglia raggiunta (${consecutiveFailures}/${failuresThreshold}), forzo passaggio a groq`);
            currentProvider = "groq";
        }
    }
}

export function incrementConsecutiveFailures() {
    if (!isScheduledRun) {
        log(`Avvio manuale: fallimenti non incrementati`);
        return;
    }
    consecutiveFailures++;
    log(`Incremento fallimenti consecutivi a ${consecutiveFailures}`);
    salvaStatoProvider();
}

export function resetConsecutiveFailures() {
    if (!isScheduledRun) {
        log(`Avvio manuale: reset fallimenti non eseguito`);
        return;
    }
    if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        log(`Reset fallimenti consecutivi (Gemini ha prodotto articoli)`);
        salvaStatoProvider();
    }
}

export function getCurrentProvider() {
    return currentProvider;
}

async function trovaUltimoModelloGemini() {
    if (!apiKeyGemini) return;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKeyGemini}`);
        const data = await res.json();
        if (data.models) {
            const validi = data.models
                .filter(m => m.name.includes("gemini") && m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            const flash = validi.filter(m => m.includes("flash")).sort((a,b)=>b.localeCompare(a));
            if (flash.length) activeGeminiModel = flash[0];
            else if (validi.length) activeGeminiModel = validi.sort((a,b)=>b.localeCompare(a))[0];
            log(`Modello Gemini selezionato: ${activeGeminiModel}`);
        }
    } catch(e) { log(`Ricerca modello Gemini fallita: ${e.message}`); }
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
            log(`Modello Groq aggiornato: ${migliore} (era ${groqModelCorrente})`);
            groqModelCorrente = migliore;
        }
        if (groqModelCorrente.includes("gemma")) groqMaxTokens = 512;
        else if (groqModelCorrente.includes("llama3-70b")) groqMaxTokens = 2000;
        else if (groqModelCorrente.includes("llama3-8b")) groqMaxTokens = 1024;
        else if (groqModelCorrente.includes("mixtral")) groqMaxTokens = 2000;
        else groqMaxTokens = 1024;
        log(`Groq max_tokens=${groqMaxTokens} per ${groqModelCorrente}`);
    } catch(e) { log(`Errore lista modelli Groq: ${e.message}`); }
}

async function callGemini(sys, prompt, temperature) {
    if (!apiKeyGemini) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${apiKeyGemini}`;
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
                        log("❌ QUOTA GIORNALIERA GEMINI (429)");
                        quotaLogSent = true;
                    }
                    return null;
                }
                if (d.error.code === 429 || d.error.code === 503) {
                    if (msg.includes("quota exceeded")) {
                        if (!quotaLogSent) log("⏳ Quota exceeded, attendo retry...");
                        quotaLogSent = true;
                        await gestisciErroreQuota(d.error.message, log);
                        continue;
                    }
                    const ms = Math.pow(2,i)*10000;
                    if (i===0) log(`⏳ Errore ${d.error.code}, retry in ${ms/1000}s`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                if (!msg.includes("quota")) log(`ERRORE GEMINI: ${d.error.message} (code: ${d.error.code})`);
                return null;
            }
            if (d.candidates?.length) return d.candidates[0].content.parts[0].text;
            return null;
        } catch(e) {
            log(`ERRORE RETE GEMINI: ${e.message}`);
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
    
    if (sys.length > MAX_SYS) log(`System message troncato da ${sys.length} a ${MAX_SYS} caratteri`);
    
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
                    log(`Modello richiede un solo messaggio, unisco system+user.`);
                    messages = [{ role: "user", content: finalSys + "\n\n" + finalPrompt }];
                    continue;
                }
                log(`ERRORE GROQ: ${d.error?.message || res.status} (code: ${d.error?.code || res.status})`);
                if (msg.includes("limit") || d.error?.code === 429) return null;
                if (d.error?.code === 400 && (msg.includes("max_tokens") || msg.includes("context_window"))) {
                    if (currentMax > 128) {
                        currentMax = Math.max(128, Math.floor(currentMax*0.6));
                        log(`Riduzione max_tokens a ${currentMax}`);
                        continue;
                    }
                    return null;
                }
                if (d.error?.code === 400 && msg.includes("reduce the length")) {
                    finalPrompt = finalPrompt.substring(0, Math.floor(finalPrompt.length*0.6)) + "... [troncato 2]";
                    if (messages.length===1) messages[0].content = finalSys + "\n\n" + finalPrompt;
                    else messages[1].content = finalPrompt;
                    log(`Prompt ridotto a ${finalPrompt.length} char`);
                    continue;
                }
                if ([429,503,500].includes(d.error?.code)) {
                    const ms = Math.pow(2,i)*10000;
                    log(`⏳ Errore ${d.error.code}, retry in ${ms/1000}s`);
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
            log(`ERRORE RETE GROQ: ${e.message}`);
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
        log(`✅ Articolo generato da ${provider}`);
        return { provider, text: result };
    }
    
    log(`⚠️ Nessun articolo valido da ${provider}, salto la generazione`);
    return null;
}

export async function initModels() {
    await trovaUltimoModelloGemini();
    if (apiKeyGroq) await trovaUltimoModelloGroq();
}
