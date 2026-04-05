// Trova dove inizia e finisce il vero JSON
        let start = Math.min(...[clean.indexOf('['), clean.indexOf('{')].filter(i => i !== -1));
        let end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
        
        if (start !== -1 && end !== -1) {
            return JSON.parse(clean.substring(start, end + 1));
        }
        throw new Error("Parentesi mancanti nel JSON");
    } catch (e) {
        scriviLog(`❌ Errore critico lettura dati di Gemini: ${e.message}`);
        return []; 
    }
}

async function callGemini(system, prompt, temp) {
    if (!apiKey) {
        scriviLog("❌ ERRORE: Chiave Motore (API_KEY) mancante.");
        return null;
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;
    
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: system }] },
                generationConfig: { responseMimeType: "application/json", temperature: parseFloat(temp) }
            })
        });
        
        if (!res.ok) {
            const errorText = await res.text();
            scriviLog(`❌ ERRORE API GOOGLE (${res.status}): ${errorText}`);
            return null;
        }

        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) { 
        scriviLog(`❌ ERRORE DI RETE GEMINI: ${e.message}`);
        return null; 
    }
}

async function fetchRSS(query, max) {
    if (max <= 0) return [];
    scriviLog(`🔍 Ricerca RSS in corso per: ${query}...`);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            scriviLog(`❌ ERRORE RSS GOOGLE NEWS: ${res.status}`);
            return [];
        }
        const xml = await res.text();
        const titles = [];
        const regex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        let m;
        while ((m = regex.exec(xml)) !== null && titles.length < max) { 
            titles.push(m[1]); 
        }
        scriviLog(`✅ Trovati ${titles.length} articoli per ${query}.`);
        return titles;
    } catch(e) { 
        scriviLog(`❌ ERRORE DI RETE RSS: ${e.message}`);
        return []; 
    }
}

async function main() {
    scriviLog(`⚓️ Inizio turno. Oggi è ${oggi.toUpperCase()}.`);

    // Avvio Auto-Discovery PRIMA di fare qualsiasi altra cosa
    await autoDiscoverModel();

    let configPath = path.join(DATA_DIR, `config_${oggi}.json`);
    if (!fs.existsSync(configPath)) {
        scriviLog(`Nessun ordine speciale per oggi (${oggi}). Uso config.json di default.`);
        configPath = path.join(DATA_DIR, "config.json");
    }

    const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    fs.writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    fs.writeFileSync(AUTH_PATH, JSON.stringify({ 
        key: adminPwd, 
        secrets: secretData.split('|').map(s => s.trim()), 
        updated: new Date().toLocaleString() 
    }));

    for (const k of Object.keys(CONFIG)) {
        if (["site_settings", "satira_config"].includes(k)) continue;
        let allNews = [];
        const sezConf = CONFIG[k];

        scriviLog(`\n🌊 Esplorazione Zona: ${k.toUpperCase()}`);

        for (const [query, s] of Object.entries(sezConf)) {
            if (query === "color" || s.count <= 0) continue;

            if (s.label === "Satira") {
                for (let i = 0; i < s.count; i++) {
                    const tema = CONFIG.satira_config.temi[Math.floor(Math.random() * CONFIG.satira_config.temi.length)];
                    scriviLog(`📝 Affido Satira a Gemini... Tema: ${tema}`);
                    const raw = await callGemini(
                        "Sei un autore satirico. Rispondi SOLO in JSON con questo formato: {\"titolo\":\"...\",\"sommario\":\"...\",\"commento\":\"...\"}", 
                        `Scrivi una fake news satirica a tema Pescara. Tema: ${tema}`, 
                        s.weight
                    );
                    
                    const parsedData = parseNews(raw);
                    if (parsedData && !Array.isArray(parsedData) && parsedData.titolo) { 
                        allNews.push({ ...parsedData, categoria: s.label, immagine: s.img, isFake: true, mood: s.mood }); 
                        scriviLog(`✅ Satira generata e imbarcata.`);
                    } else {
                        scriviLog(`⚠️ Riprovo satira per errore formato...`);
                        i--; // Riprova se fallisce
                    }
                }
            } else {
                const titles = await fetchRSS(query, s.count);
                if (titles.length > 0) {
                    scriviLog(`🤖 Invio titoli a Gemini (Stile: ${s.mood})...`);
                    const raw = await callGemini(
                        `Sei un giornalista ${s.mood}. Rispondi SOLO in formato ARRAY JSON: [{"titolo":"...","sommario":"...","commento":"..."}]`, 
                        `Rielabora questi titoli di notizie in un breve sommario e aggiungi un commento pungente in stile giornalista. Titoli:\n${titles.join('\n')}`, 
                        s.weight
                    );
                    
                    const parsedArray = parseNews(raw);
                    if (Array.isArray(parsedArray) && parsedArray.length > 0) {
                        allNews.push(...parsedArray.map(n => ({ ...n, categoria: s.label, immagine: s.img, isFake: false, mood: s.mood }))); 
                        scriviLog(`✅ Notizie elaborate per ${query}.`);
                    } else {
                        scriviLog(`❌ Gemini ha restituito un formato illeggibile per ${query}.`);
                    }
                } else {
                    scriviLog(`⚠️ Nessuna novità all'orizzonte per ${query}.`);
                }
            }
        }
        
        fs.writeFileSync(path.join(DATA_DIR, `news-${k}.json`), JSON.stringify({ today: new Date().toLocaleDateString('it-IT', {weekday:'long', day:'numeric', month:'long'}), color: sezConf.color, news: allNews }, null, 2));
    }
    scriviLog("🏁 Turno completato. Nave in porto.");
}

main();
