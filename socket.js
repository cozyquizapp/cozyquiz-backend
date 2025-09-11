// frontend/src/views/TeamFixed.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import socket, { connectWithTeamId } from '../socket';

function Avatar({ src, size = 56 }) {
  if (typeof src === 'string' && src.startsWith('/')) {
    return (
      <img
        src={src}
        alt="avatar"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          boxShadow: '0 6px 18px rgba(0,0,0,.35)',
          border: '2px solid rgba(255,255,255,.1)',
        }}
      />
    );
  }
  return <span style={{ fontSize: size * 0.8 }}>{src || '❓'}</span>;
}

/** KRANICH: 3 Runden (duell) */
const KRANICH_ROUNDS = [
  {
    title: 'Filmreihen',
    items: ['Harry Potter', 'Herr der Ringe', 'Star Wars', 'Die Tribute von Panem'],
    categories: [
      { id: 'startjahr', label: 'Startjahr' },
      { id: 'anzahl', label: 'Anzahl Filme' },
      { id: 'einspiel', label: 'Einspielergebnis' },
    ],
  },
  {
    title: 'Social Media',
    items: ['TikTok', 'Facebook', 'Instagram', 'Twitter (X)'],
    categories: [
      { id: 'gruendung', label: 'Gründungsjahr' },
      { id: 'posts', label: 'Posts pro Minute' },
      { id: 'maus', label: 'Monatlich aktive Nutzer' },
    ],
  },
  {
    title: 'Popstars',
    items: ['Taylor Swift', 'Ed Sheeran', 'Billie Eilish', 'TheWeeknd'],
    categories: [
      { id: 'geburtsjahr', label: 'Geburtsjahr' },
      { id: 'song', label: 'Meistgehörter Song (Spotify)'},
      { id: 'ig', label: 'Instagram-Follower' },
    ],
  },
];

export default function TeamFixed({ fixedId, defaultName, defaultAvatar }) {
  const [st, setSt] = useState(null);
  const [teams, setTeams] = useState([]);

  // Einsätze
  const [stake, setStake] = useState(0);
  const [useJoker, setUseJoker] = useState(false);

  // Hase
  const [haseAns, setHaseAns] = useState(['', '', '', '']);

  // KRANICH
  const [kranichCategory, setKranichCategory] = useState('');
  const [kranichOrder, setKranichOrder] = useState(['', '', '', '']);

  // Robbe
  const [robbe, setRobbe] = useState({ a: 40, b: 40, c: 20 });

  // Eule (3 Runden: 0=r1, 1=r3, 2=r4)
  const [euleRound1, setEuleRound1] = useState(Array(15).fill(''));
  const [euleRound3, setEuleRound3] = useState(Array(3).fill(''));
  const [euleRound4, setEuleRound4] = useState(Array(4).fill(''));

  // Wal
  const [walBid, setWalBid] = useState(0);

  // Bär
  const [baer, setBaer] = useState('');

  // Fuchs
  const [fuchs, setFuchs] = useState('');

  // Timer – lokales Ticken
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  // 🔔 Beep bei erstem Buzz im Spiel (akustisches Feedback)
  const lastBuzzCountRef = useRef(0);
  const beepRef = useRef(null);
  useEffect(() => {
    beepRef.current = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = 880;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
        o.start();
        o.stop(ctx.currentTime + 0.22);
      } catch {}
    };
  }, []);
  useEffect(() => {
    if (!st || st.currentCategory !== 'Elch') { lastBuzzCountRef.current = 0; return; }
    const cnt = (st.elch?.buzzOrder || []).length;
    if (cnt === 1 && lastBuzzCountRef.current === 0) {
      beepRef.current && beepRef.current();
    }
    lastBuzzCountRef.current = cnt;
  }, [st?.elch?.buzzOrder?.length, st?.currentCategory]);

  // Connect + Join
  useEffect(() => {
    const s = connectWithTeamId(fixedId);
    const onState = (g) => {
      setSt(g);
      s.emit('requestTeams');
    };
    const onTeams = (list) => setTeams(list);

    // Ergebnis direkt empfangen und in den State eintragen (robust für verschiedene Strukturen)
    const onResultAnnounce = (result) => {
      // Debug: Zeige das empfangene Ergebnisobjekt in der Konsole
      console.log('[result:announce]', result);

      setSt((prev) => {
        if (!prev) return prev;
        let newResults = prev.results ? { ...prev.results } : {};

        // Versuche, nach Kategorie zu sortieren
        const catKey = result.category || prev.currentCategory || 'unknown';
        if (!catKey) return prev;

        // Falls mehrere Runden pro Kategorie: als Array speichern
        if (!Array.isArray(newResults[catKey])) newResults[catKey] = [];
        if (typeof result.roundIndex === 'number') {
          newResults[catKey][result.roundIndex] = result;
        } else {
          newResults[catKey][0] = result;
        }

        return { ...prev, results: newResults };
      });
    };

    s.on('state:update', onState);
    s.on('teamsUpdated', onTeams);
    s.on('result:announce', onResultAnnounce);

    s.emit('team:join', { name: defaultName, avatar: defaultAvatar });
    s.emit('requestState');
    s.emit('requestTeams');

    return () => {
      s.off('state:update', onState);
      s.off('teamsUpdated', onTeams);
      s.off('result:announce', onResultAnnounce);
    };
  }, [fixedId, defaultName, defaultAvatar]);

  const me = useMemo(() => teams.find((t) => t.id === fixedId), [teams, fixedId]);
  const coins = me?.coins ?? 0;
  const quizJoker = me?.quizJoker ?? 0;
  const phase = st?.phase || 'LOBBY';
  const cat = st?.currentCategory;
  const roundIndex = Number(st?.roundIndex || 0);

  // Inputs leeren & Kranich/Eule initialisieren beim Wechsel
  const roundKey = `${st?.currentCategory || 'NONE'}#${st?.roundIndex || 0}#${st?.phase}`;
  useEffect(() => {
    if (st?.phase === 'CATEGORY') {
      // Reset generisch
      setHaseAns(['', '', '', '']);
      setRobbe({ a: 40, b: 40, c: 20 });
      setWalBid(0);
      setBaer('');
      setFuchs('');

      // Kranich vorbereiten
      if (st?.currentCategory === 'Kranich') {
        const def = KRANICH_ROUNDS[roundIndex] || KRANICH_ROUNDS[0];
        setKranichCategory(def.categories[0]?.id || '');
        setKranichOrder(def.items.slice());
      } else {
        setKranichCategory('');
        setKranichOrder(['', '', '', '']);
      }

      // Eule leeren
      setEuleRound1(Array(15).fill(''));
      setEuleRound3(Array(3).fill(''));
      setEuleRound4(Array(4).fill(''));
    }
  }, [roundKey]);

  // Stake senden
  const sendStake = () =>
    socket.emit('team:setStake', { stake: Number(stake) || 0, useJoker });

  // Timer calc
  const endsAt = st?.timerEndsAt || null;
  const duration = Math.max(0, Number(st?.timerDuration || 0));
  const remainingMs = endsAt ? Math.max(0, endsAt - now) : 0;
  const remainingSec = Math.ceil(remainingMs / 1000);
  const progress = endsAt ? 1 - Math.min(1, remainingMs / (duration * 1000 || 1)) : 0;

  // KRANICH helpers
  const moveUp = (i) => {
    if (i <= 0) return;
    const a = [...kranichOrder];
    [a[i - 1], a[i]] = [a[i], a[i - 1]];
    setKranichOrder(a);
  };
  const moveDown = (i) => {
    if (i >= kranichOrder.length - 1) return;
    const a = [...kranichOrder];
    [a[i + 1], a[i]] = [a[i], a[i + 1]];
    setKranichOrder(a);
  };
  const kranichSubmit = () =>
    socket.emit('team:kranich:submit', {
      category: kranichCategory,
      order: kranichOrder,
    });

  // Eule submit – Mapping: 0→r1, 1→r3, 2→r4
  const euleSubmit = () => {
    if (roundIndex === 0) {
      socket.emit('team:eule:submit', { r1: euleRound1 });
    } else if (roundIndex === 1) {
      socket.emit('team:eule:submit', { r3: euleRound3 });
    } else if (roundIndex === 2) {
      socket.emit('team:eule:submit', { r4: euleRound4 });
    } else {
      socket.emit('team:eule:submit', {}); // safety
    }
  };

  // Hilfsfunktion: Hole das Ergebnis-Objekt für die aktuelle Kategorie/Runde (robust für alle Strukturen)
  function getCurrentResult() {
    if (!st) return null;
    // 1. Suche nach st.results als Objekt mit Kategorie-Schlüssel
    if (st.results && typeof st.results === 'object' && cat && st.results[cat]) {
      if (Array.isArray(st.results[cat])) {
        return st.results[cat][roundIndex] || null;
      }
      // Falls nur ein Objekt pro Kategorie
      return st.results[cat];
    }
    // 2. Suche nach st.results als Array (legacy)
    if (Array.isArray(st.results) && typeof roundIndex === 'number') {
      const res = st.results[roundIndex];
      if (res && (res.category === cat || !res.category)) return res;
    }
    // 3. Suche nach st.result (Fallback)
    if (st.result && st.result.category === cat) return st.result;
    // 4. Fallback: Suche nach einem Ergebnisobjekt, das winnerId für mein Team enthält
    if (st.results && typeof st.results === 'object') {
      for (const key in st.results) {
        const entry = st.results[key];
        if (Array.isArray(entry)) {
          for (const r of entry) {
            if (r && r.winnerId && (r.category === cat || !r.category) && typeof r.roundIndex === 'number' && r.roundIndex === roundIndex) {
              return r;
            }
          }
        } else if (entry && entry.winnerId && (entry.category === cat || !entry.category)) {
          return entry;
        }
      }
    }
    return null;
  }

  // Hilfsfunktion: Hat mein Team die Runde gewonnen?
  const didMyTeamWin = (() => {
    const res = getCurrentResult();
    if (!res) return null;
    if ('winnerId' in res) {
      if (res.winnerId === fixedId) return true;
      if (res.winnerId) return false;
    }
    // Fallback: falls Struktur anders, ggf. anpassen
    return null;
  })();

  // Rückmeldungstexte für jede Kategorie
  const resultFeedback = useMemo(() => {
    // Zeige Feedback, sobald ein Gewinner existiert (unabhängig von phase)
    if (didMyTeamWin == null) return null;
    let msg = '';
    let emoji = didMyTeamWin ? '🏆' : '😢';
    switch (cat) {
      case 'Hase':
        msg = didMyTeamWin
          ? 'Glückwunsch! Ihr habt diese Hase-Runde gewonnen und den Punkt geholt.'
          : 'Leider hat das andere Team diese Hase-Runde gewonnen.';
        break;
      case 'Kranich':
        msg = didMyTeamWin
          ? 'Super! Ihr habt die Kranich-Runde gewonnen und den Punkt erhalten.'
          : 'Schade, das andere Team war bei Kranich besser.';
        break;
      case 'Robbe':
        msg = didMyTeamWin
          ? 'Stark! Ihr habt die Robbe-Runde gewonnen und den Punkt geholt.'
          : 'Leider hat das andere Team die Robbe-Runde gewonnen.';
        break;
      case 'Eule':
        msg = didMyTeamWin
          ? 'Klasse! Ihr habt die Eule-Runde gewonnen und den Punkt erhalten.'
          : 'Das andere Team war bei Eule erfolgreicher.';
        break;
      case 'Wal':
        msg = didMyTeamWin
          ? 'Ihr habt die Wal-Runde gewonnen und den Punkt geholt!'
          : 'Das andere Team hat die Wal-Runde gewonnen.';
        break;
      case 'Elch':
        msg = didMyTeamWin
          ? 'Ihr wart beim Elch am schnellsten und habt den Punkt geholt!'
          : 'Das andere Team war beim Elch schneller.';
        break;
      case 'Bär':
        msg = didMyTeamWin
          ? 'Sehr gut! Ihr habt die Bär-Runde gewonnen und den Punkt erhalten.'
          : 'Das andere Team war bei Bär näher dran.';
        break;
      case 'Fuchs':
        msg = didMyTeamWin
          ? 'Ihr habt die Fuchs-Runde gewonnen und den Punkt geholt!'
          : 'Das andere Team war bei Fuchs besser.';
        break;
      default:
        msg = didMyTeamWin
          ? 'Ihr habt diese Runde gewonnen!'
          : 'Leider hat das andere Team diese Runde gewonnen.';
    }
    return (
      <div className={`result-feedback ${didMyTeamWin ? 'win' : 'lose'}`}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>{emoji}</div>
        <div>{msg}</div>
      </div>
    );
  }, [cat, didMyTeamWin]);

  // ————— RENDER —————
  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header">
        <div className="team-head">
          <Avatar src={me?.avatar ?? defaultAvatar} />
          <div className="team-meta">
            <div className="team-name">{me?.name ?? defaultName}</div>
            <div className="team-bank">
              <span>💰 {coins} Coins</span>
              <span>🎟 {quizJoker} Joker</span>
            </div>
          </div>
        </div>
      </header>

      {/* Timer */}
      <div className={`timer ${endsAt ? 'active' : ''}`}>
        <div
          className="timer-bar"
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}
        />
        <div className="timer-label">{endsAt ? `${remainingSec}s` : '—'}</div>
      </div>

      {/* Status */}
      <div className="status-line">
        <span className="badge">{phase}</span>
        {cat && <span className="sep">·</span>}
        {cat && <span className="badge badge-alt">{cat}</span>}
        {phase === 'CATEGORY' && <span className="sep">·</span>}
        {phase === 'CATEGORY' && <span>Runde {roundIndex + 1}/3</span>}
      </div>

      {/* Content */}
      <main className="content">
        {/* Rückmeldung nach Runde */}
        {resultFeedback}

        {/* Stake */}
        {phase === 'STAKE' && (
          <section className="card">
            <h3>Einsatz wählen</h3>
            <div className="grid3">
              <button
                className={`btn ${stake === 3 ? 'btn-primary' : ''}`}
                disabled={coins < 3}
                onClick={() => setStake(3)}
              >
                Setze 3
              </button>
              <button
                className={`btn ${stake === 6 ? 'btn-primary' : ''}`}
                disabled={coins < 6}
                onClick={() => setStake(6)}
              >
                Setze 6
              </button>
              <button
                className={`btn ${stake === 0 ? 'btn-primary' : ''}`}
                onClick={() => setStake(0)}
              >
                Setze 0
              </button>
            </div>
            {stake > 0 && quizJoker > 0 && (
              <label className="chk">
                <input
                  type="checkbox"
                  checked={useJoker}
                  onChange={(e) => setUseJoker(e.target.checked)}
                />
                Joker (Verdoppler)
              </label>
            )}
            <button className="btn btn-cta" onClick={sendStake}>
              Einsatz senden
            </button>
          </section>
        )}

        {/* Hase */}
        {phase === 'CATEGORY' && cat === 'Hase' && (
          <section className="card">
            <h3>Hase</h3>
            <div className="grid2">
              {haseAns.map((v, i) => (
                <input
                  key={i}
                  className="input"
                  placeholder={`Name ${i + 1}`}
                  value={v}
                  onChange={(e) => {
                    const a = [...haseAns];
                    a[i] = e.target.value;
                    setHaseAns(a);
                  }}
                />
              ))}
            </div>
            <button
              className="btn btn-cta"
              onClick={() => socket.emit('team:hase:submit', { answers: haseAns })}
            >
              Senden
            </button>
          </section>
        )}

        {/* Kranich */}
        {phase === 'CATEGORY' && cat === 'Kranich' && (
          <section className="card">
            <h3>Kranich – {(KRANICH_ROUNDS[roundIndex] || KRANICH_ROUNDS[0]).title}</h3>

            <label className="label">Sortierkategorie</label>
            <select
              className="select"
              value={kranichCategory}
              onChange={(e) => setKranichCategory(e.target.value)}
            >
              {(KRANICH_ROUNDS[roundIndex] || KRANICH_ROUNDS[0]).categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>

            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              {kranichOrder.map((v, i) => (
                <div key={i} className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="pill" style={{ minWidth: 42, textAlign: 'center' }}>
                    {i + 1}
                  </div>
                  <div style={{ flex: 1, padding: '0 8px' }}>{v}</div>
                  <div className="row">
                    <button className="btn" disabled={i === 0} onClick={() => moveUp(i)}>
                      ↑
                    </button>
                    <button
                      className="btn"
                      disabled={i === kranichOrder.length - 1}
                      onClick={() => moveDown(i)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button className="btn btn-cta" style={{ marginTop: 10 }} onClick={kranichSubmit}>
              Senden
            </button>
          </section>
        )}

        {/* Robbe */}
        {phase === 'CATEGORY' && cat === 'Robbe' && (
          <section className="card">
            <h3>Robbe</h3>
            {['a', 'b', 'c'].map((k) => (
              <div key={k} className="row">
                <span className="pill">{k.toUpperCase()}</span>
                <input
                  type="number"
                  className="input"
                  value={robbe[k]}
                  onChange={(e) =>
                    setRobbe({
                      ...robbe,
                      [k]: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                    })
                  }
                />
                <span>%</span>
              </div>
            ))}
            <button
              className="btn btn-cta"
              onClick={() => socket.emit('team:robbe:submit', { perc: robbe })}
            >
              Senden
            </button>
          </section>
        )}

        {/* Eule */}
        {phase === 'CATEGORY' && cat === 'Eule' && (
          <section className="card">
            <h3>Eule</h3>

            {roundIndex === 0 && (
              <>
                <p className="muted" style={{ marginTop: -6 }}>
                  Nenne so viele Animationsfilme wie möglich (bis zu 15).
                </p>
                <div className="grid3">
                  {euleRound1.map((v, i) => (
                    <input
                      key={i}
                      className="input"
                      placeholder={`Film ${i + 1}`}
                      value={v}
                      onChange={(e) => {
                        const arr = [...euleRound1];
                        arr[i] = e.target.value;
                        setEuleRound1(arr);
                      }}
                    />
                  ))}
                </div>
                <button className="btn btn-cta" onClick={euleSubmit} style={{ marginTop: 10 }}>
                  Senden
                </button>
              </>
            )}

            {roundIndex === 1 && (
              <>
                <p className="muted" style={{ marginTop: -6 }}>
                  Erkenne die 3 unkenntlichen Poster (links → rechts).
                </p>
                <div className="grid3">
                  {euleRound3.map((v, i) => (
                    <input
                      key={i}
                      className="input"
                      placeholder={`Poster ${i + 1}`}
                      value={v}
                      onChange={(e) => {
                        const arr = [...euleRound3];
                        arr[i] = e.target.value;
                        setEuleRound3(arr);
                      }}
                    />
                  ))}
                </div>
                <button className="btn btn-cta" onClick={euleSubmit} style={{ marginTop: 10 }}>
                  Senden
                </button>
              </>
            )}

            {roundIndex === 2 && (
              <>
                <p className="muted" style={{ marginTop: -6 }}>
                  Erkenne, was auf den 4 Postern fehlt (links → rechts).
                </p>
                <div className="grid2">
                  {euleRound4.map((v, i) => (
                    <input
                      key={i}
                      className="input"
                      placeholder={`Poster ${i + 1}`}
                      value={v}
                      onChange={(e) => {
                        const arr = [...euleRound4];
                        arr[i] = e.target.value;
                        setEuleRound4(arr);
                      }}
                    />
                  ))}
                </div>
                <button className="btn btn-cta" onClick={euleSubmit} style={{ marginTop: 10 }}>
                  Senden
                </button>
              </>
            )}
          </section>
        )}

        {/* Wal */}
        {phase === 'CATEGORY' && cat === 'Wal' && (
          <section className="card">
            <h3>Wal</h3>
            <label className="label">Gebot</label>
            <input
              type="number"
              className="input"
              value={walBid}
              onChange={(e) => setWalBid(e.target.value)}
            />
            <button
              className="btn btn-cta"
              onClick={() => socket.emit('team:wal:submit', { bid: Number(walBid) || 0 })}
            >
              Senden
            </button>
          </section>
        )}

        {/* ——— ELCH ——— */}
        {phase === 'CATEGORY' && cat === 'Elch' && (
          <section className="card">
            <h3>Elch</h3>
            <p className="muted" style={{ marginTop: -6 }}>
              Kategoriesprache:&nbsp;
              <b>{st?.elch?.category || (st?.elch?.exhausted ? '— Pool erschöpft —' : '— (Admin zieht) —')}</b>
            </p>

            <button
              className="btn big-buzz"
              disabled={!!st?.elch?.buzzLocked || !!st?.submissions?.[fixedId]?.buzz || !st?.elch?.category}
              onClick={() => socket.emit('team:elch:buzz')}
            >
              🔔 BUZZ!
            </button>

            <div className="muted" style={{ marginTop: 8 }}>
              {!st?.elch?.category
                ? 'Warten, bis der Admin eine Sprache zieht …'
                : st?.elch?.buzzLocked
                  ? 'Buzz ist gesperrt (der erste Buzz zählt).'
                  : (!!st?.submissions?.[fixedId]?.buzz ? 'Du hast bereits gebuzzert.' : 'Buzz ist frei.')}
            </div>
          </section>
        )}

        {/* Bär */}
        {phase === 'CATEGORY' && cat === 'Bär' && (
          <section className="card">
            <h3>Bär</h3>

            {/* Runden-Hinweis */}
            {roundIndex === 0 && (
              <p className="muted" style={{ marginTop: -6 }}>
                Schätze die Flugdauer in <b>Stunden (Dezimal)</b>.
              </p>
            )}
            {roundIndex === 1 && (
              <p className="muted" style={{ marginTop: -6 }}>
                Schätze die Anzahl Kitas in Deutschland.
              </p>
            )}
            {roundIndex === 2 && (
              <p className="muted" style={{ marginTop: -6 }}>
                Schätze die Höhe des höchsten Wolkenkratzers in <b>Metern</b>.
              </p>
            )}

            <label className="label">Deine Schätzung</label>
            <input
              className="input"
              inputMode={roundIndex === 0 ? 'decimal' : 'numeric'}
              step={roundIndex === 0 ? '0.01' : '1'}
              placeholder={
                roundIndex === 0 ? 'z. B. 12.5'
                : roundIndex === 1 ? 'z. B. 50000'
                : 'z. B. 900'
              }
              value={baer}
              onChange={(e) => setBaer(e.target.value)}
            />

            <button
              className="btn btn-cta"
              onClick={() => socket.emit('team:baer:submit', { estimate: Number(baer) })}
              style={{ marginTop: 10 }}
            >
              Senden
            </button>
          </section>
        )}

        {/* Fuchs */}
        {phase === 'CATEGORY' && cat === 'Fuchs' && (
          <section className="card">
            <h3>Fuchs</h3>
            <label className="label">Dein Tipp</label>
            <input className="input" value={fuchs} onChange={(e) => setFuchs(e.target.value)} />
            <button
              className="btn btn-cta"
              onClick={() => socket.emit('team:fuchs:submit', { guess: fuchs })}
            >
              Senden
            </button>
          </section>
        )}
      </main>
    </div>
  );
}