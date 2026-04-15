import { scriviLog } from "./utils.js";

let logFn = null;
let gnewsApiKey = "";
let newsSource = "gnews";

export function initNews(apiKey, source, logFunction) {
    gnewsApiKey = apiKey;
    newsSource = source;
    logFn = logFunction;
}

async function fetchGNews(query, max) {
    if (!gnewsApiKey) return [];
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=it&country=it&max=${max}&token=${gnewsApiKey}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || data.errors) {
            logFn(`[GNews ERR] Status ${res.status}`);
            return [];
        }
        if (!data.articles) return [];
        const titles = data.articles.map(art => art.title);
        if (titles.length === 0) logFn(`[GNews] 0 titoli per "${query}"`);
        else logFn(`[GNews] ${titles.length} titoli per "${query}"`);
        return titles;
    } catch(e) {
        logFn(`[GNews] Eccezione: ${e.message}`);
        return [];
    }
}

async function fetchRSS(query, max) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
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
        return titles;
    } catch(e) {
        logFn(`RSS errore per "${query}": ${e.message}`);
        return [];
    }
}

export async function raccoltaNotizie(vociAttive, parole, contatori) {
    const codaArticoli = [];
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
        logFn("⚠️ GNews zero titoli per tutte le voci. Passo a RSS.");
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
            for (let i=0; i<num; i++) {
                codaArticoli.push({ voce, tema: temi[Math.floor(Math.random() * temi.length)] });
            }
        }
    }
    for (const { voce, titoli } of risultati) {
        const num = voce.num || 1;
        for (const t of titoli) codaArticoli.push({ voce, tema: t });
        if (titoli.length < num) {
            const mancanti = num - titoli.length;
            logFn(`[CASCATA] Solo ${titoli.length}/${num} per "${voce.arg}". Aggiungo ${mancanti} generici.`);
            for (let i=0; i<mancanti; i++) {
                codaArticoli.push({ voce, tema: `[Generico] ${voce.arg} - approfondimento` });
            }
        }
    }
    return codaArticoli;
}