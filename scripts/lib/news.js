let logFn = null;
let gnewsApiKey = "";
let newsSource = "gnews";
const log = (msg) => logFn("[news] " + msg);

export function initNews(apiKey, source, logFunction) {
    gnewsApiKey = apiKey;
    newsSource = source;
    logFn = logFunction;
}

async function fetchGNews(query, max) {
    if (!gnewsApiKey) return [];
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=it&country=it&max=${max}&token=${gnewsApiKey}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (res.status === 429) {
            log(`Rate limit (429) per "${query}", attendo 60s e riprovo...`);
            await new Promise(r => setTimeout(r, 60000));
            const retryRes = await fetch(url);
            const retryData = await retryRes.json();
            if (retryRes.ok && !retryData.errors) {
                const titles = retryData.articles?.map(a => a.title) || [];
                log(`Retry OK: ${titles.length} titoli per "${query}"`);
                return titles;
            } else {
                log(`Retry fallito per "${query}"`);
                return [];
            }
        }
        if (!res.ok || data.errors) {
            log(`ERR Status ${res.status}, query: "${query}"`);
            return [];
        }
        const titles = data.articles?.map(a => a.title) || [];
        if (titles.length === 0) {
            log(`0 titoli per "${query}" (nessuna notizia)`);
        } else {
            log(`${titles.length} titoli per "${query}"`);
        }
        return titles;
    } catch(e) {
        log(`Eccezione: ${e.message}`);
        return [];
    }
}

async function fetchRSS(query, max) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    log(`Richiesta RSS: "${query}"`);
    try {
        const res = await fetch(url);
        if (!res.ok) {
            log(`RSS HTTP ${res.status} per "${query}"`);
            return [];
        }
        const xml = await res.text();
        const titles = [];
        const dueGiorniFa = Date.now() - 2 * 24 * 3600000;
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && titles.length < max) {
            const item = m[1];
            const pd = item.match(/<pubDate>(.*?)<\/pubDate>/i);
            if (pd && new Date(pd[1]).getTime() < dueGiorniFa) continue;
            const tl = item.match(/<title>(.*?)<\/title>/i);
            if (tl) {
                let t = tl[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").split(" - ")[0].trim();
                if (!titles.includes(t)) titles.push(t);
            }
        }
        log(`RSS: ${titles.length} titoli per "${query}"`);
        return titles;
    } catch(e) {
        log(`RSS errore: ${e.message}`);
        return [];
    }
}

export async function raccoltaNotizie(vociAttive, parole, contatori) {
    const codaArticoli = [];
    const visti = new Set();
    let tutteZero = true;
    const risultati = [];

    for (const voce of vociAttive) {
        const num = voce.num || 1;
        voce._parole = parole;
        if (voce.tipo === "GEN") continue;
        let titoli = [];
        if (newsSource === "gnews") {
            titoli = await fetchGNews(voce.arg, num);
            contatori.rss_fetch = (contatori.rss_fetch || 0) + 1;
            if (titoli.length > 0) tutteZero = false;
        } else {
            titoli = await fetchRSS(voce.arg, num);
            contatori.rss_fetch = (contatori.rss_fetch || 0) + 1;
            if (titoli.length > 0) tutteZero = false;
        }
        risultati.push({ voce, titoli });
    }

    if (newsSource === "gnews" && tutteZero) {
        log("⚠️ GNews ha restituito zero titoli per TUTTE le voci (o errori). Passo a RSS per l'intero run.");
        newsSource = "rss";
        risultati.length = 0;
        tutteZero = true;
        for (const voce of vociAttive) {
            const num = voce.num || 1;
            if (voce.tipo === "GEN") continue;
            const titoli = await fetchRSS(voce.arg, num);
            contatori.rss_fetch = (contatori.rss_fetch || 0) + 1;
            if (titoli.length > 0) tutteZero = false;
            risultati.push({ voce, titoli });
        }
    }

    // Aggiungi GEN
    for (const voce of vociAttive) {
        const num = voce.num || 1;
        if (voce.tipo === "GEN") {
            const temi = voce.temi || [voce.arg];
            for (let i = 0; i < num; i++) {
                const tema = temi[Math.floor(Math.random() * temi.length)];
                const key = `${voce.sez}|${tema}`;
                if (!visti.has(key)) {
                    visti.add(key);
                    codaArticoli.push({ voce, tema });
                }
            }
        }
    }

    // Aggiungi notizie
    for (const { voce, titoli } of risultati) {
        const num = voce.num || 1;
        for (const t of titoli) {
            const key = `${voce.sez}|${t}`;
            if (!visti.has(key)) {
                visti.add(key);
                codaArticoli.push({ voce, tema: t });
            }
        }
        if (titoli.length < num) {
            const mancanti = num - titoli.length;
            for (let i = 0; i < mancanti; i++) {
                const temaGen = `[Generico] ${voce.arg} - approfondimento`;
                const key = `${voce.sez}|${temaGen}`;
                if (!visti.has(key)) {
                    visti.add(key);
                    codaArticoli.push({ voce, tema: temaGen });
                }
            }
        }
    }
    return codaArticoli;
}
