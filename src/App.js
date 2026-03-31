import { useState, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────
//  HEADER BACKGROUND SVG GHIBLI
// ─────────────────────────────────────────────────────────
const HeaderBg = ({ isPescara }) => (
  <svg viewBox="0 0 1400 320" xmlns="http://www.w3.org/2000/svg"
    style={{ position:"absolute", inset:0, width:"100%", height:"100%", display:"block" }}>
    <defs>
      <linearGradient id="hsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={isPescara ? "#a8d8f2" : "#c0e8f5"}/>
        <stop offset="100%" stopColor={isPescara ? "#d0eef8" : "#e8f2d8"}/>
      </linearGradient>
      <filter id="hbl"><feGaussianBlur stdDeviation="5"/></filter>
    </defs>
    <rect width="1400" height="320" fill="url(#hsky)"/>
    {/* Sole */}
    <circle cx="1150" cy="72" r="70" fill={isPescara ? "#b0e4f8" : "#f5e8b0"} opacity="0.45" filter="url(#hbl)"/>
    <circle cx="1150" cy="72" r="42" fill={isPescara ? "#60c8f0" : "#f5c030"} opacity="0.82"/>
    {/* Nuvole */}
    {[[80,52,115,36],[290,36,95,30],[540,58,135,40],[800,42,100,32],[1020,55,88,28],[1280,48,110,34]].map(([cx,cy,rx,ry],i)=>(
      <g key={i} opacity="0.65">
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="white" filter="url(#hbl)"/>
        <ellipse cx={cx-rx*.26} cy={cy-ry*.24} rx={rx*.52} ry={ry*.52} fill="white" opacity=".62"/>
        <ellipse cx={cx+rx*.2} cy={cy-ry*.18} rx={rx*.38} ry={ry*.38} fill="white" opacity=".5"/>
      </g>
    ))}
    {/* Colline */}
    <path d="M0,218 Q350,158 700,175 Q1050,158 1400,212 L1400,320 L0,320Z"   fill={isPescara?"#55b8d5":"#78b840"} opacity="0.35"/>
    <path d="M0,248 Q250,215 500,228 Q750,215 1000,240 Q1200,225 1400,244 L1400,320 L0,320Z" fill={isPescara?"#38a0c8":"#5a9e38"} opacity="0.5"/>
    <path d="M0,278 Q350,258 700,268 Q1050,252 1400,274 L1400,320 L0,320Z"   fill={isPescara?"#2888b5":"#3a7a20"} opacity="0.7"/>
    <path d="M0,302 Q350,292 700,298 Q1050,308 1400,295 L1400,320 L0,320Z"   fill={isPescara?"#1870a0":"#4a9ad4"} opacity="0.45"/>
    {/* Alberi / palme */}
    {isPescara
      ? [130,310,580,820,1080,1300].map(x => (
          <g key={x}><rect x={x-2} y="240" width="4" height="50" fill="#1a4a28" opacity="0.45"/>
          <ellipse cx={x} cy="235" rx="20" ry="22" fill="#2a7a38" opacity="0.48"/></g>
        ))
      : [110,265,460,650,900,1120,1340].map((x,i) => (
          <g key={x}><rect x={x-5} y="232" width="9" height="55" fill="#1a2e10" opacity="0.42"/>
          <circle cx={x} cy="224" r={26+i%3*9} fill="#3a7a20" opacity="0.5"/></g>
        ))
    }
    {/* Delfino (solo Pescara) */}
    {isPescara && (
      <g opacity="0.5">
        <path d="M380,295 Q425,268 478,285 Q500,298 478,310 Q448,322 385,310Z" fill="#0088c8"/>
        <path d="M478,310 Q502,288 515,314" fill="none" stroke="#0088c8" strokeWidth="9" strokeLinecap="round"/>
        <circle cx="408" cy="295" r="4" fill="#001828" opacity="0.6"/>
      </g>
    )}
    {/* Uccellini */}
    {[200,420,700,950,1200].map((x,i) => (
      <path key={x} d={`M${x},${92+i*7} Q${x+9},${86+i*7} ${x+18},${92+i*7}`}
        fill="none" stroke="#1a2e10" strokeWidth="1.5" opacity="0.35" strokeLinecap="round"/>
    ))}
  </svg>
);

// ─────────────────────────────────────────────────────────
//  BANNER AGGIORNAMENTO IN CORSO
// ─────────────────────────────────────────────────────────
const UpdateBanner = ({ ACC }) => (
  <div style={{
    position: "sticky", top: 0, zIndex: 100,
    background: `${ACC}f0`, backdropFilter: "blur(8px)",
    borderBottom: `2px solid ${ACC}`,
    padding: ".6rem 1.5rem",
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: ".8rem"
  }}>
    {/* Spinner animato */}
    <div style={{
      width: 16, height: 16, borderRadius: "50%",
      border: "2.5px solid rgba(255,255,255,.35)",
      borderTopColor: "#fff",
      animation: "spin 1s linear infinite",
      flexShrink: 0
    }}/>
    <p style={{
      fontFamily: "'Nunito', sans-serif", fontSize: ".78rem",
      fontWeight: 700, color: "#fff", margin: 0, letterSpacing: ".04em"
    }}>
      🐬 Il delfino sta aggiornando le notizie — stai leggendo l'edizione precedente
    </p>
  </div>
);

// ─────────────────────────────────────────────────────────
//  CARD NOTIZIA
// ─────────────────────────────────────────────────────────
const Card = ({ item, ACC, ACC2, INK, MUTED, RULE, aggiornato }) => {
  const isFake = item.isFake;
  return (
    <article style={{
      background: "#f8f2e8ee",
      border: `1px solid ${isFake ? ACC2 : RULE}`,
      borderRadius: 6, overflow: "hidden",
      boxShadow: `0 2px 16px rgba(0,0,0,.06)`,
      transition: "transform .28s, box-shadow .28s",
      position: "relative"
    }}
    onMouseEnter={e => { e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.boxShadow=`0 8px 28px rgba(0,0,0,.12)`; }}
    onMouseLeave={e => { e.currentTarget.style.transform="translateY(0)"; e.currentTarget.style.boxShadow=`0 2px 16px rgba(0,0,0,.06)`; }}>

      {/* Badge satira */}
      {isFake && (
        <div style={{
          position: "absolute", top: 12, right: 12, zIndex: 10,
          background: ACC2, color: "#fff8e8",
          fontFamily: "'Nunito', sans-serif", fontSize: ".58rem",
          fontWeight: 800, letterSpacing: ".12em",
          padding: ".2rem .75rem", borderRadius: 10
        }}>✨ SATIRA</div>
      )}

      {/* Illustrazione SVG */}
      <div style={{
        width: "100%", aspectRatio: "16/7", overflow: "hidden",
        background: `linear-gradient(135deg, #c8e8d0, #d8e8f8)`
      }}>
        {item.svg
          ? <div style={{ width:"100%", height:"100%" }}
                 dangerouslySetInnerHTML={{ __html: item.svg }}/>
          : <div style={{
              width:"100%", height:"100%",
              background: "linear-gradient(135deg,#c0e8c8,#d8ecf8)",
              display:"flex", alignItems:"center", justifyContent:"center"
            }}>
              <span style={{ fontSize:"2rem", opacity:.25 }}>🎨</span>
            </div>
        }
      </div>

      {/* Testo */}
      <div style={{ padding: "clamp(1.1rem,2.5vw,1.8rem) clamp(1.1rem,2.5vw,2rem) clamp(.9rem,2vw,1.4rem)" }}>
        {/* Categoria + luogo */}
        <div style={{ display:"flex", gap:".7rem", alignItems:"center", marginBottom:".8rem", flexWrap:"wrap" }}>
          <span style={{
            background: `${isFake ? ACC2 : ACC}1a`, color: isFake ? ACC2 : ACC,
            border: `1px solid ${isFake ? ACC2 : ACC}44`,
            fontFamily: "'Nunito', sans-serif", fontSize: ".58rem",
            fontWeight: 800, letterSpacing: ".1em",
            padding: ".18rem .7rem", borderRadius: 10, textTransform: "uppercase"
          }}>{item.categoria}</span>
          <span style={{ fontFamily:"'Nunito',sans-serif", color: MUTED, fontSize:".6rem" }}>
            📍 {item.luogo}
          </span>
        </div>

        {/* Divisore Ghibli */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:".85rem" }}>
          <div style={{ flex:1, height:1, background:`linear-gradient(to right,transparent,${RULE})` }}/>
          <span style={{ color:RULE, fontSize:".62rem" }}>✦</span>
          <div style={{ flex:1, height:1, background:`linear-gradient(to left,transparent,${RULE})` }}/>
        </div>

        {/* Titolo */}
        <h2 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: "clamp(1.08rem,2.1vw,1.42rem)",
          fontWeight: 700, lineHeight: 1.28,
          color: isFake ? ACC2 : INK,
          margin: "0 0 .85rem",
          fontStyle: isFake ? "italic" : "normal"
        }}>{item.titolo}</h2>

        {/* Sommario */}
        <p style={{
          fontFamily: "'Crimson Pro', Georgia, serif",
          fontSize: "clamp(.88rem,1.6vw,1.02rem)",
          color: MUTED, lineHeight: 1.7, margin: "0 0 1rem"
        }}>{item.sommario}</p>

        {/* Box commento sarcastico */}
        <div style={{
          background: `${ACC}0c`, border: `1px solid ${ACC}28`,
          borderLeft: `3px solid ${isFake ? ACC2 : ACC}`,
          padding: ".85rem 1rem", borderRadius: "0 4px 4px 0", marginBottom: ".75rem"
        }}>
          <p style={{
            fontFamily: "'Nunito', sans-serif", color: isFake ? ACC2 : ACC,
            fontSize: ".56rem", fontWeight: 800, letterSpacing: ".12em",
            textTransform: "uppercase", margin: "0 0 .3rem"
          }}>{isFake ? "✨ Nota satirica" : "😏 Il delfino commenta"}</p>
          <p style={{
            fontFamily: "'Crimson Pro', Georgia, serif",
            fontSize: "clamp(.8rem,1.4vw,.92rem)",
            color: isFake ? `${ACC2}cc` : `${INK}aa`,
            fontStyle: "italic", lineHeight: 1.55, margin: 0
          }}>{item.commento}</p>
        </div>

        {/* Footer card */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", borderTop:`1px solid ${RULE}`, paddingTop:".65rem" }}>
          <span style={{ fontFamily:"'Nunito',sans-serif", color:RULE, fontSize:".55rem" }}>
            {isFake ? "✱ Articolo satirico — non reale" : `via ${item.fonte}`}
          </span>
          {aggiornato && (
            <span style={{ fontFamily:"'Crimson Pro',serif", color:RULE, fontSize:".62rem", fontStyle:"italic" }}>
              {aggiornato}
            </span>
          )}
        </div>
      </div>
    </article>
  );
};

// ─────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────
export default function LaVoceDelDelfino() {
  const [mode,       setMode]      = useState("mondo");
  const [data,       setData]      = useState(null);
  const [isUpdating, setIsUpdating]= useState(false);
  const [loading,    setLoading]   = useState(true);
  const [error,      setError]     = useState(null);

  const isPescara = mode === "pescara";
  const PAPER2 = isPescara ? "#d8eef6" : "#ede4d0";
  const INK    = isPescara ? "#183848" : "#281e08";
  const ACC    = isPescara ? "#0082c4" : "#8a6412";
  const ACC2   = isPescara ? "#38b0e0" : "#c88820";
  const MUTED  = isPescara ? "#486e88" : "#786040";
  const RULE   = isPescara ? "#a0c8d8" : "#c8b488";

  // Legge status.json per sapere se è in corso un aggiornamento
  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.PUBLIC_URL}/data/status.json?t=${Date.now()}`);
      if (!res.ok) return;
      const status = await res.json();
      setIsUpdating(status.updating === true);
    } catch {}
  }, []);

  // Carica i dati delle notizie dal JSON salvato da GitHub Actions
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const file = isPescara ? "news-pescara.json" : "news-mondo.json";
      const ts   = Math.floor(Date.now() / 60_000); // cache-bust ogni minuto
      const res  = await fetch(`${process.env.PUBLIC_URL}/data/${file}?t=${ts}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.news && json.news.length > 0) {
        setData(json);
      } else {
        setError("Notizie non ancora disponibili — il delfino sta lavorando!");
      }
    } catch(e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isPescara]);

  // Caricamento iniziale e al cambio modalità
  useEffect(() => {
    loadData();
    checkStatus();
  }, [loadData, checkStatus]);

  // Polling: controlla status ogni 60s e ricarica dati ogni 5 minuti
  useEffect(() => {
    const statusTimer = setInterval(checkStatus, 60_000);
    const dataTimer   = setInterval(loadData, 5 * 60_000);
    return () => { clearInterval(statusTimer); clearInterval(dataTimer); };
  }, [checkStatus, loadData]);

  const news = data?.news || [];
  const aggiornato = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleString("it-IT", {
        day: "numeric", month: "long", hour: "2-digit", minute: "2-digit"
      })
    : null;

  const today = new Date().toLocaleDateString("it-IT", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });

  return (
    <div style={{ background: PAPER2, minHeight: "100vh", color: INK }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Crimson+Pro:ital,wght@0,300;0,400;1,300;1,400&family=Nunito:wght@400;600;700;800&display=swap');
        *  { box-sizing: border-box; }
        body { margin: 0; }
        @keyframes slideUp { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
        @keyframes float   { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-7px); } }
        @keyframes spin    { to { transform:rotate(360deg); } }
        @keyframes sway    { 0%,100% { transform:rotate(-1.5deg); } 50% { transform:rotate(1.5deg); } }
        @keyframes tickmove { from { transform:translateX(0); } to { transform:translateX(-50%); } }
        @keyframes pulse   { 0%,100% { opacity:1; } 50% { opacity:.55; } }
        .ca { animation: slideUp .5s ease both; }
        .tab-btn {
          font-family: 'Nunito', sans-serif; font-size: .7rem; font-weight: 800;
          letter-spacing: .1em; text-transform: uppercase; border: none;
          cursor: pointer; padding: .52rem 1.4rem; transition: all .2s; border-radius: 20px;
        }
      `}</style>

      {/* BANNER aggiornamento in corso (sticky, sempre visibile) */}
      {isUpdating && <UpdateBanner ACC={ACC}/>}

      {/* HEADER */}
      <header style={{
        position: "relative", overflow: "hidden", minHeight: 285,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "flex-end",
        paddingBottom: "1.8rem"
      }}>
        <HeaderBg isPescara={isPescara}/>
        <div style={{
          position: "relative", zIndex: 2, textAlign: "center",
          padding: "1.8rem clamp(1rem,4vw,3rem) 0", width: "100%"
        }}>
          {/* Delfino fluttuante */}
          <div style={{ fontSize:"2.5rem", marginBottom:".4rem", animation:"float 3s ease-in-out infinite", lineHeight:1 }}>
            🐬
          </div>

          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: "clamp(1.9rem,6vw,4.6rem)",
            fontWeight: 900, lineHeight: 1.05, letterSpacing: "-.02em",
            color: INK, margin: "0 0 .28rem"
          }}>
            La Voce del Delfino
          </h1>

          <p style={{
            fontFamily: "'Crimson Pro', serif",
            fontSize: "clamp(.82rem,1.7vw,1.08rem)",
            color: MUTED, fontStyle: "italic", margin: "0 0 .5rem"
          }}>
            {isPescara
              ? "Storie di mare e di arrosticini — aggiornate due volte al giorno"
              : "Notizie belle dal mondo — dipinte in acquerello da Gemini"}
          </p>

          {/* Orari aggiornamento */}
          <p style={{
            fontFamily: "'Nunito', sans-serif", fontSize: ".62rem", color: MUTED,
            letterSpacing: ".1em", textTransform: "uppercase", margin: "0 0 .4rem", fontWeight: 600
          }}>
            🕐 aggiornato alle 06:00 e alle 12:00 · {today}
          </p>

          {/* Timestamp ultimo aggiornamento */}
          {aggiornato && (
            <p style={{
              fontFamily: "'Nunito', sans-serif", fontSize: ".58rem", color: MUTED,
              letterSpacing: ".08em", textTransform: "uppercase", margin: "0 0 1rem",
              opacity: .75
            }}>
              ultima edizione: {aggiornato}
            </p>
          )}

          {/* TAB SWITCHER */}
          <div style={{
            display: "inline-flex", gap: ".4rem",
            background: "rgba(255,255,255,.5)", padding: ".36rem",
            borderRadius: 24, backdropFilter: "blur(8px)",
            border: `1px solid ${RULE}`, marginBottom: ".6rem"
          }}>
            <button className="tab-btn" onClick={() => setMode("mondo")}
              style={{
                background: mode==="mondo" ? ACC2 : "transparent",
                color: mode==="mondo" ? "#fff8e8" : MUTED,
                boxShadow: mode==="mondo" ? `0 2px 12px ${ACC2}55` : "none"
              }}>
              🌍 Notizie dal Mondo
            </button>
            <button className="tab-btn" onClick={() => setMode("pescara")}
              style={{
                background: mode==="pescara" ? ACC : "transparent",
                color: mode==="pescara" ? "white" : MUTED,
                boxShadow: mode==="pescara" ? `0 2px 12px ${ACC}55` : "none"
              }}>
              🐬 Pescara &amp; Abruzzo
            </button>
          </div>
        </div>
      </header>

      {/* TICKER */}
      {news.length > 0 && (
        <div style={{
          background: `${ACC}18`, borderTop: `1px solid ${RULE}`,
          borderBottom: `1px solid ${RULE}`, height: "2.1rem",
          display: "flex", alignItems: "center", overflow: "hidden"
        }}>
          <div style={{
            background: `${ACC}28`, color: ACC, padding: "0 .9rem",
            fontFamily: "'Nunito', sans-serif", fontSize: ".58rem", fontWeight: 800,
            letterSpacing: ".14em", textTransform: "uppercase", height: "100%",
            display: "flex", alignItems: "center", flexShrink: 0,
            borderRight: `1px solid ${RULE}`
          }}>🐬 OGGI</div>
          <div style={{ flex:1, overflow:"hidden" }}>
            <div style={{ display:"inline-flex", animation:"tickmove 55s linear infinite", whiteSpace:"nowrap" }}>
              {[...news, ...news].map((n,i) => (
                <span key={i} style={{
                  fontFamily: "'Crimson Pro', serif", fontSize: ".78rem",
                  color: MUTED, fontStyle: "italic", padding: "0 2.2rem"
                }}>
                  {n.isFake ? "✨ " : "✦ "}{n.titolo}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MAIN */}
      <main style={{ width:"100%", padding:"2.5rem clamp(1rem,4vw,4rem) 6rem" }}>

        {/* SKELETON / LOADING iniziale */}
        {loading && news.length === 0 && (
          <div style={{ textAlign:"center", padding:"6rem 2rem" }}>
            <div style={{ fontSize:"2.8rem", marginBottom:"1rem", animation:"float 2s ease-in-out infinite" }}>
              {isPescara ? "🐬" : "🌿"}
            </div>
            <p style={{ fontFamily:"'Playfair Display',serif", fontSize:"1.2rem", color:INK, margin:"0 0 .4rem" }}>
              Carico le notizie...
            </p>
            <p style={{ fontFamily:"'Crimson Pro',serif", color:MUTED, fontStyle:"italic", fontSize:".9rem" }}>
              Il delfino legge il giornale di oggi
            </p>
          </div>
        )}

        {/* ERRORE (nessuna notizia disponibile) */}
        {error && news.length === 0 && (
          <div style={{
            background: "rgba(255,255,255,.8)", border: `1px solid ${ACC2}80`,
            padding: "2rem", textAlign: "center", borderRadius: 8,
            maxWidth: 540, margin: "4rem auto"
          }}>
            <div style={{ fontSize:"2.5rem", marginBottom:".8rem" }}>🌊</div>
            <p style={{ fontFamily:"'Playfair Display',serif", color:INK, fontSize:"1.1rem", margin:"0 0 .5rem" }}>
              Notizie in arrivo
            </p>
            <p style={{ fontFamily:"'Crimson Pro',serif", color:MUTED, fontStyle:"italic", margin:"0 0 .8rem" }}>
              {error}
            </p>
            <p style={{ fontFamily:"'Nunito',sans-serif", color:MUTED, fontSize:".68rem", letterSpacing:".06em" }}>
              Il workflow aggiorna le notizie alle 06:00 e alle 12:00 italiane.
            </p>
            <button onClick={loadData} style={{
              marginTop: "1.2rem", border: "none", padding: ".8rem 2rem",
              fontFamily: "'Nunito',sans-serif", fontSize: ".72rem", fontWeight: 800,
              letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer",
              borderRadius: 20, background: `linear-gradient(135deg,${ACC},${ACC2})`,
              color: "#fff8e8"
            }}>↺ Riprova</button>
          </div>
        )}

        {/* NEWS */}
        {news.length > 0 && (
          <div style={{
            display: "flex", flexDirection: "column", gap: "2.8rem",
            maxWidth: "min(100%, 900px)", margin: "0 auto"
          }}>
            {news.map((item, idx) => (
              <div key={idx} className="ca" style={{ animationDelay:`${Math.min(idx * 0.03, 0.5)}s` }}>
                {/* Numerazione */}
                <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:"1rem" }}>
                  <span style={{
                    fontFamily: "'Playfair Display',serif", fontSize:"2rem",
                    fontWeight:900, color:`${ACC}38`, lineHeight:1
                  }}>
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <div style={{ flex:1, height:1, background:`linear-gradient(to right,${ACC}38,transparent)` }}/>
                  {item.isFake && (
                    <span style={{
                      fontFamily: "'Nunito',sans-serif", fontSize:".55rem",
                      fontWeight:800, color:ACC2, letterSpacing:".12em", textTransform:"uppercase"
                    }}>✨ SATIRA</span>
                  )}
                </div>
                <Card item={item} ACC={ACC} ACC2={ACC2} INK={INK} MUTED={MUTED} RULE={RULE} aggiornato={aggiornato}/>
              </div>
            ))}

            {/* Footer */}
            <div style={{ textAlign:"center", padding:"2rem 0", borderTop:`1px solid ${RULE}` }}>
              <div style={{ fontSize:"1.8rem", marginBottom:".7rem" }}>🐬</div>
              <p style={{ fontFamily:"'Crimson Pro',serif", color:MUTED, fontStyle:"italic", fontSize:".92rem", margin:"0 0 .5rem" }}>
                {isPescara
                  ? "Prossimo aggiornamento alle 06:00 o alle 12:00. Il delfino non va mai in vacanza."
                  : "Prossimo aggiornamento alle 06:00 o alle 12:00. Totoro è già al lavoro."}
              </p>
              <p style={{ fontFamily:"'Nunito',sans-serif", color:`${RULE}99`, fontSize:".54rem", marginTop:".8rem", letterSpacing:".08em", textTransform:"uppercase" }}>
                Notizie cercate sul web da Gemini · Illustrazioni SVG Ghibli generate da Gemini AI · ✨ = satira inventata
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
