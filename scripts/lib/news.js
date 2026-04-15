export async function raccoltaNotizie(vociAttive, parole, contatori) {
    const codaArticoli = [];
    const visti = new Set();
    let tutteZero = true;
    const risultati = [];

    // ... raccolta titoli (invariata) ...

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
