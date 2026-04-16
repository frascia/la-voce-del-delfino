/**
 * FILE: lib/news.js
 * DATA: 2025-04-16
 * VERSIONE: 2.4
 * DESCRIZIONE: Gestione della raccolta notizie da GNews e RSS.
 *              Supporta fallback automatico da GNews a RSS.
 *              Log dettagliati con fonte e numero di notizie.
 *              Restituisce oggetti con titolo e data di pubblicazione.
 */

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
    if (!gnewsApiKey) {
        log(`⚠️ GNews: chiave API mancante per "${query}"`);
        return [];
    }
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=it&country=it&max=${max}&token=${gnewsApiKey}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (res.status === 429) {
            log(`⏳ GNews: rate limit (429) per "${query}", attendo 60s...`);
            await new Promise(r => setTimeout(r, 60000));
            const retryRes = await fetch(url);
            const retryData = await retryRes.json();
            if (retryRes.ok && !retryData.errors) {
                const articles = retryData.articles?.map(a => ({
                    title: a.title,
                    publishedAt: a.publishedAt || null
                })) || [];
                log(`✓ GNews: ${articles.length} notizie per "${query}" (dopo retry)`);
                return articles;
            }
            log(`✗ GNews: retry fallito per "${query}"`);
            return [];
        }
        
        if (!res.ok || data.errors) {
            log(`✗ GNews: errore ${res.status} per "${query}"`);
            return [];
        }
        
        const articles = data.articles?.map(a => ({
            title: a.title,
            publishedAt: a.publishedAt || null
        })) || [];
        
        if (articles.length === 0) {
            log(`○ GNews: 0 notizie per "${query}"`);
        } else {
            log(`✓ GNews: ${articles.length} notizie per "${query}"`);
        }
        return articles;
    } catch(e) {
        log(`✗ GNews: eccezione - ${e.message}`);
        return [];
    }
}

async function fetchRSS(query, max) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it&v=${Date.now()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            log(`✗ RSS: errore ${res.status} per "${query}"`);
            return [];
        }
        const xml = await res.text();
        const articles = [];
        const dueGiorniFa = Date.now() - 2 * 24 * 3600000;
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRegex.exec(xml)) !== null && articles.length < max) {
            const item = m[1];
            const pd = item.match(/<pubDate>(.*?)<\/pubDate>/i);
            let pubDate = null;
            let pubDateISO = null;
            if (pd) {
                pubDate = pd[1];
                const parsedDate = new Date(pubDate);
                if (!isNaN(parsedDate.getTime())) {
                    pubDateISO = parsedDate.toISOString();
                    if (parsedDate.getTime() < dueGiorniFa) continue;
                }
            }
            const tl = item.match(/<title>(.*?)<\/title>/i);
            if (tl) {
                let t = tl[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").split(" - ")[0].trim();
                if (!articles.some(a => a.title === t)) {
                    articles.push({
                        title: t,
                        publishedAt: pubDateISO
                    });
                }
            }
        }
        if (articles.length === 0) {
            log(`○ RSS: 0 notizie per "${query}"`);
        } else {
            log(`✓ RSS: ${articles.length} notizie per "${query}"`);
        }
        return articles;
    } catch(e) {
        log(`✗ RSS: eccezione - ${e.message}`);
        return [];
    }
}

export async function raccoltaNotizie(vociAttive, parole, contatori) {
    const codaArticoli = [];
    const visti = new Set();
    let tutteZero = true;
    const risultati = [];

    log(`📡 Fonte notizie: ${newsSource.toUpperCase()}`);

    // Prima fase: raccolta con la fonte attuale (solo voci RSS)
    for (const voce of vociAttive) {
        const num = voce.num || 1;
        voce._parole = parole;
        if (voce.tipo !== "RSS") continue;
        
        let articoli = [];
        if (newsSource === "gnews") {
            articoli = await fetchGNews(voce.arg, num);
            contatori.rss_fetch = (contatori.rss_fetch || 0) + 1;
            if (articoli.length > 0) tutteZero = false;
        } else {
            articoli = await fetchRSS(voce.arg, num);
            contatori.rss_fetch = (contatori.rss_fetch || 0) + 1;
            if (articoli.length > 0) tutteZero = false;
        }
        risultati.push({ voce, articoli });
    }

    // Se GNews ha dato zero notizie per tutte le voci RSS, passa a RSS (cascata)
    if (newsSource === "gnews" && tutteZero && risultati.length > 0) {
        log(`⚠️ GNews: 0 notizie per TUTTE le voci RSS → passaggio a RSS (cascata)`);
        newsSource = "rss";
        risultati.length = 0;
        tutteZero = true;
        for (const voce of vociAttive) {
            const num = voce.num || 1;
            if (voce.tipo !== "RSS") continue;
            const articoli = await fetchRSS(voce.arg, num);
            contatori.rss_fetch = (contatori.rss_fetch || 0) + 1;
            if (articoli.length > 0) tutteZero = false;
            risultati.push({ voce, articoli });
        }
    }

    // Aggiungi articoli di tipo GEN (generazione libera)
    let countGEN = 0;
    for (const voce of vociAttive) {
        const num = voce.num || 1;
        if (voce.tipo === "GEN") {
            const temi = voce.temi || [voce.arg];
            for (let i = 0; i < num; i++) {
                const tema = temi[Math.floor(Math.random() * temi.length)];
                const key = `${voce.sez}|${tema}`;
                if (!visti.has(key)) {
                    visti.add(key);
                    codaArticoli.push({ voce, tema, publishedAt: null });
                    countGEN++;
                }
            }
        }
    }
    if (countGEN > 0) log(`📝 GEN: ${countGEN} articoli da generazione libera`);

    // Aggiungi articoli di tipo RED (Dalla Redazione)
    let countRED = 0;
    for (const voce of vociAttive) {
        const num = voce.num || 1;
        if (voce.tipo === "RED") {
            const temi = voce.temi || [voce.arg || "Riflessione personale"];
            for (let i = 0; i < num; i++) {
                const tema = temi[Math.floor(Math.random() * temi.length)];
                const key = `${voce.sez}|${tema}`;
                if (!visti.has(key)) {
                    visti.add(key);
                    codaArticoli.push({ voce, tema, publishedAt: null });
                    countRED++;
                }
            }
        }
    }
    if (countRED > 0) log(`✍️ RED: ${countRED} articoli redazionali`);

    // Aggiungi le notizie RSS/GNews raccolte (con data)
    let countRSS = 0;
    let countGenerici = 0;
    for (const { voce, articoli } of risultati) {
        const num = voce.num || 1;
        for (const art of articoli) {
            const key = `${voce.sez}|${art.title}`;
            if (!visti.has(key)) {
                visti.add(key);
                codaArticoli.push({ voce, tema: art.title, publishedAt: art.publishedAt });
                countRSS++;
            }
        }
        if (articoli.length < num) {
            const mancanti = num - articoli.length;
            log(`⚠️ ${voce.arg}: solo ${articoli.length}/${num} notizie → aggiungo ${mancanti} generici (cascata interna)`);
            for (let i = 0; i < mancanti; i++) {
                const temaGen = `[Generico] ${voce.arg} - approfondimento`;
                const key = `${voce.sez}|${temaGen}`;
                if (!visti.has(key)) {
                    visti.add(key);
                    codaArticoli.push({ voce, tema: temaGen, publishedAt: null });
                    countGenerici++;
                }
            }
        }
    }
    if (countRSS > 0) log(`📰 RSS: ${countRSS} notizie reali`);
    if (countGenerici > 0) log(`🔄 Generici: ${countGenerici} articoli di riempimento`);

    log(`📦 Totale articoli in coda: ${codaArticoli.length} (RSS:${countRSS}, GEN:${countGEN}, RED:${countRED}, GENERICI:${countGenerici})`);
    
    return codaArticoli;
}