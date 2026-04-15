import { scriviLog, pausaGemini, gestisciErroreQuota, caricaJSON, salvaJSON } from "./utils.js";

let logFn = null;
let apiKeyGemini = "", apiKeyGroq = "";
let groqModelCorrente = "llama3-70b-8192";
let groqMaxTokens = 1024;
let ricercaEffettuata = false;
let currentProvider = "gemini";
let failureCount = 0;
let quotaLogSent = false;
let providerStatePath = "";
let activeGeminiModel = "gemini-1.5-flash";

export function initLLM(geminiKey, groqKey, providerStateFile, logFunction) {
    apiKeyGemini = geminiKey;
    apiKeyGroq = groqKey;
    providerStatePath = providerStateFile;
    logFn = logFunction;
    const saved = caricaJSON(providerStatePath, { provider: "gemini", failureCount: 0 });
    currentProvider = saved.provider;
    failureCount = saved.failureCount;
}

function salvaStatoProvider() {
    salvaJSON(providerStatePath, { provider: currentProvider, failureCount: 0 });
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
            logFn(`[MODELLO] Gemini: ${activeGeminiModel}`);
        }
    } catch(e) { logFn(`[WARN] Ricerca modello Gemini: ${e.message}`); }
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
            logFn(`[GROQ] Modello aggiornato: ${migliore} (era ${groqModelCorrente})`);
            groqModelCorrente = migliore;
        }
        if (groqModelCorrente.includes("gemma")) groqMaxTokens = 512;
        else if (groqModelCorrente.includes("llama3-70b")) groqMaxTokens = 2000;
        else if (groqModelCorrente.includes("llama3-8b")) groqMaxTokens = 1024;
        else if (groqModelCorrente.includes("mixtral")) groqMaxTokens = 2000;
        else groqMaxTokens = 1024;
        logFn(`[GROQ] max_tokens=${groqMaxTokens} per ${groqModelCorrente}`);
    } catch(e) { logFn(`[GROQ] Errore lista modelli: ${e.message}`); }
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
                        logFn("❌ QUOTA GIORNALIERA GEMINI (429)");
                        quotaLogSent = true;
                    }
                    return null;
                }
                if (d.error.code === 429 || d.error.code === 503) {
                    if (msg.includes("quota exceeded")) {
                        if (!quotaLogSent) logFn("⏳ Quota exceeded, attendo retry...");
                        quotaLogSent = true;
                        await gestisciErroreQuota(d.error.message, logFn);
                        continue;
                    }
                    const ms = Math.pow(2,i)*10000;
                    if (i===0) logFn(`⏳ Errore ${d.error.code}, retry in ${ms/1000}s`);
                    await new Promise(r => setTimeout(r, ms));
                    continue;
                }
                if (!msg.includes("quota")) logFn(`[ERRORE GEMINI] ${d.error.message} (code: ${d.error.code})`);
                return null;
            }
            if (d.candidates?.length) return d.candidates[0].content.parts[0].text;
            return null;
        } catch(e) {
            logFn(`[ERRORE RETE GEMINI] ${e.message}`);
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
    let finalSys = sys.length > 4000 ? sys.substring(0,4000)+"... [troncato]" : sys;
    let finalPrompt = prompt.length > 15000 ? prompt.substring(0,15000)+"... [troncato]" : prompt;
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
                    logFn(`[GROQ] Modello richiede un solo messaggio, unisco system+user.`);
                    messages = [{ role: "user", content: finalSys + "\n\n" + finalPrompt }];
                    continue;
                }
                logFn(`[ERRORE GROQ] ${d.error?.message || res.status} (code: ${d.error?.code || res.status})`);
                if (msg.includes("limit") || d.error?.code === 429) return null;
                if (d.error?.code === 400 && (msg.includes("max_tokens") || msg.includes("context_window"))) {
                    if (currentMax > 128) {
                        currentMax = Math.max(128, Math.floor(currentMax*0.6));
                        logFn(`[GROQ] Riduzione max_tokens a ${currentMax}`);
                        continue;
                    }
                    return null;
                }
                if (d.error?.code === 400 && msg.includes("reduce the length")) {
                    finalPrompt = finalPrompt.substring(0, Math.floor(finalPrompt.length*0.6)) + "... [troncato 2]";
                    if (messages.length===1) messages[0].content = finalSys + "\n\n" + finalPrompt;
                    else messages[1].content = finalPrompt;
                    logFn(`[GROQ] Prompt ridotto a ${finalPrompt.length} char`);
                    continue;
                }
                if ([429,503,500].includes(d.error?.code)) {
                    const ms = Math.pow(2,i)*10000;
                    logFn(`⏳ Errore ${d.error.code}, retry in ${ms/1000}s`);
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
            logFn(`[ERRORE RETE GROQ] ${e.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return null;
}

export async function callLLM(sys, prompt, temperature = 0.85) {
    const tryProvider = async (provider) => {
        return provider === "groq" ? await callGroq(sys, prompt, temperature) : await callGemini(sys, prompt, temperature);
    };
    let result = await tryProvider(currentProvider);
    if (result && !result.includes("contenuto non generato") && JSON.parse(result).articolo?.length > 50) {
        failureCount = 0;
        return result;
    }
    failureCount++;
    logFn(`⚠️ Fallimento ${currentProvider} (${failureCount}/2)`);
    if (failureCount >= 2) {
        const old = currentProvider;
        currentProvider = currentProvider === "gemini" ? "groq" : "gemini";
        logFn(`🔄 Cambio provider: ${old} → ${currentProvider}`);
        failureCount = 0;
        salvaStatoProvider();
        const newResult = await tryProvider(currentProvider);
        if (newResult && !newResult.includes("contenuto non generato")) return newResult;
        logFn(`❌ Anche ${currentProvider} fallisce.`);
        return JSON.stringify({ titolo: prompt.substring(0,60), articolo: "Contenuto non generato per problemi del provider.", commento: "" });
    }
    return JSON.stringify({ titolo: prompt.substring(0,60), articolo: "Contenuto non generato per problemi temporanei.", commento: "" });
}

export async function initModels() {
    await trovaUltimoModelloGemini();
    if (apiKeyGroq) await trovaUltimoModelloGroq();
}