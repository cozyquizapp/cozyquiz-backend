import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ELCH_LANGS } from './src/constants.js';

/* =============================
   Server-Bootstrap
================================*/
const app = express();
const server = http.createServer(app);
// Allow overriding CORS origins via env (comma separated list)
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      try {
        if (!origin) return cb(null, true); // allow non-browser or same-origin
        const matchDefault =
          /https?:\/\/([a-z0-9-]+\.)?cozyquiz\.app$/i.test(origin) ||
          /https?:\/\/localhost(?::\d+)?$/i.test(origin) ||
          /https?:\/\/(127\.0\.0\.1|192\.168\.[0-9.]+)(?::\d+)?$/i.test(origin);
        const matchExtra = EXTRA_ORIGINS.some(o => o && origin.toLowerCase() === o.toLowerCase());
        return cb(null, matchDefault || matchExtra);
      } catch {
        return cb(null, false);
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  }
});
// internal timer handle for auto-hiding race
let raceAutoTmo = null;

/* =============================
   Idempotency (actionId-based)
   - Prevent duplicate processing when client retries (ACK timeouts)
   - 10s sliding window; cleanup every minute
================================*/
const IDEMP_WINDOW_MS = 10_000;
// Simple structured logger (JSON if LOG_JSON=1) else formatted text
const LOG_JSON = process.env.LOG_JSON === '1';
function logEvent(type, meta){
  try {
    if(LOG_JSON){
      console.log(JSON.stringify({ ts: Date.now(), type, ...meta }));
    } else {
      console.log(`[${type}]`, meta);
    }
  } catch {}
}
// Configurable (env) Elch answer window after first buzz (ms)
// Default now 45s (45000ms) if not provided
const ELCH_ANSWER_WINDOW_MS = (() => {
  const raw = Number(process.env.ELCH_ANSWER_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
})();
const _recentActions = new Map(); // actionId -> ts
function isDuplicateAction(actionId){
  if(!actionId) return false;
  const now = Date.now();
  // purge occasionally (cheap O(n))
  if(_recentActions.size && (_recentActions._lastPurge||0) + 60_000 < now){
    for(const [k,ts] of _recentActions){ if(now - ts > IDEMP_WINDOW_MS) _recentActions.delete(k); }
    _recentActions._lastPurge = now;
  }
  if(_recentActions.has(actionId)) return true;
  _recentActions.set(actionId, now);
  return false;
}

/* =============================
   Game State & Helpers
================================*/
const VALID_STAKES = [0, 3, 6];
const ROUNDS_PER_CATEGORY = 3;

const state = {
  phase: 'LOBBY',            // 'LOBBY' | 'STAKE' | 'CATEGORY' | 'FINISHED'
  currentCategory: null,
  roundIndex: 0,             // 0..2
  stakes: {},                // teamId -> { stake:0|3|6, useJoker:boolean }
  categoryPot: 0,
  carryRound: 0,
  submissions: {},
  fuchsHistory: {},         // teamId -> [{ guess, ts }]
  // LOBBY / Join-Code fÃ¼r QR (Produktion)
  joinCode: null,            // z.B. '482913'
  // Anzahl aktiver Teams (erste N join order) â€“ konfigurierbar (2..5)
  teamLimit: 3,

  // Timer
  timerEndsAt: null,         // ms epoch (server time)
  timerDuration: 0,          // seconds (duration of current/last started countdown)
  timerPausedRemaining: 0,   // seconds remaining when paused (0 when running or reset)
  lastTimerEnd: null,        // ms epoch when timer naturally expired (for grace window)

  // ðŸ¦Œ Elch â€“ Kategoriesprache & Buzz
  elch: {
    category: null,          // z.B. "Tiere"
    used: [],                // bereits gezogene Sprachen
    buzzOrder: [],           // [{teamId, ts}]
    buzzLocked: false,       // true = Buzz gesperrt
    exhausted: false,        // true = alle Sprachen verbraucht
    phase: 'IDLE',           // 'IDLE' | 'ANNOUNCE' | 'BUZZ_READY' | 'LOCK'
    buzzAnswerEndsAt: null,  // ms epoch – Countdown nachdem erster Buzz erfolgt ist
  },

  // ðŸ Scoreboard-Race (PRE â†’ RACE â†’ POST)
  raceMode: 'POST',          // 'PRE' | 'RACE' | 'POST'

  // ðŸ“Š Kategorie-Rundensiege (teamId -> count) wÃ¤hrend laufender Kategorie
  roundWins: {},
  resolvedRounds: Object.create(null),
  // ðŸ’° Kategorie-Earnings (coin-Gewinne pro Team nur fÃ¼r diese Kategorie)
  categoryEarnings: {},
  pendingResult: null, // stores last resolved round result until announced
  lastResult: null,
};

function roundKeyFor(category, roundIdx) {
  if (!category && category !== 0) return null;
  return `${category}:${roundIdx}`;
}
function currentRoundKey() {
  return roundKeyFor(state.currentCategory, state.roundIndex);
}
function isRoundResolved(key = currentRoundKey()) {
  return key ? !!state.resolvedRounds[key] : false;
}
function markRoundResolved(flag, key = currentRoundKey()) {
  if (!key) return;
  if (flag) {
    state.resolvedRounds[key] = true;
  } else {
    delete state.resolvedRounds[key];
  }
}

function buildRoundRecap() {
  const cat = state.currentCategory;
  const subs = state.submissions || {};
  const base = { category: cat, roundIndex: state.roundIndex, submissions: subs };
  try {
    if (cat === 'Robbe') base.correctKey = state.pendingResult?.winnerKey || null;
    else if (cat === 'Bär') base.solution = null;
    else if (cat === 'Wal') base.note = 'Gebote';
    else if (cat === 'Fuchs') base.note = 'Mehrfachversuche möglich';
  } catch {}
  return base;
}

function emitPendingResult(io) {
  if (!state.pendingResult) return;
  const recap = buildRoundRecap();
  io.emit('result:announce', { ...state.pendingResult, recap });
  state.lastResult = state.pendingResult;
}

const teams = new Map();     // teamId -> { id,name,avatar,coins,quizJoker,joinedAt }

// VerfÃ¼gbare Avatar-Dateipfade (mÃ¼ssen mit frontend/public/avatars Ã¼bereinstimmen)
const AVATAR_POOL = [
  '/avatars/seekuh.png',
  '/avatars/waschbaer.png',
  '/avatars/roter_panda.png',
  '/avatars/igel.png',
  '/avatars/faultier.png',
  '/avatars/einhorn.png',
  '/avatars/eichhoernchen.png',
  '/avatars/capybara.png',
  '/avatars/wombat.png',
  '/avatars/koala.png',
  '/avatars/alpaka.png',
  '/avatars/pinguin.png',
  '/avatars/otter.png',
  '/avatars/giraffe.png',
  '/avatars/eisbaer.png',
  '/avatars/drache.png',
  '/avatars/katze.png',
  '/avatars/hund.png',
  '/avatars/teamjenny.png',
  '/avatars/teamjana.png',
  '/avatars/teammartin.png'
];

/* =============================
   Persistence (JSON on disk)
================================*/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const FILE_STATE = path.join(DATA_DIR, 'state.json');
const FILE_TEAMS = path.join(DATA_DIR, 'teams.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadPersisted(){
  try {
    if (fs.existsSync(FILE_STATE)) {
      const raw = JSON.parse(fs.readFileSync(FILE_STATE, 'utf8')) || {};
      for (const k of Object.keys(state)) {
        if (k in raw) state[k] = raw[k];
      }
    }
  } catch {}
  try {
    if (fs.existsSync(FILE_TEAMS)) {
      const arr = JSON.parse(fs.readFileSync(FILE_TEAMS, 'utf8')) || [];
      teams.clear();
      for (const t of arr) { if (t && t.id) teams.set(t.id, t); }
    }
  } catch {}
}

function snapshotState(){
  const { serverNow, ...rest } = serializeState();
  return rest;
}
function snapshotTeams(){
  return Array.from(teams.values()).map(t => ({ ...t }));
}

let saveTmo = null;
function markDirty(){
  if (saveTmo) return;
  saveTmo = setTimeout(() => {
    try { fs.writeFileSync(FILE_STATE, JSON.stringify(snapshotState(), null, 2), 'utf8'); } catch {}
    try { fs.writeFileSync(FILE_TEAMS, JSON.stringify(snapshotTeams(), null, 2), 'utf8'); } catch {}
    saveTmo = null;
  }, 600);
}

function flushPersistSync(){
  try { fs.writeFileSync(FILE_STATE, JSON.stringify(snapshotState(), null, 2), 'utf8'); } catch(e){ console.error('[persist] state flush error', e?.message); }
  try { fs.writeFileSync(FILE_TEAMS, JSON.stringify(snapshotTeams(), null, 2), 'utf8'); } catch(e){ console.error('[persist] teams flush error', e?.message); }
}

// Graceful shutdown handlers ensure current game state is not lost if server restarts
['SIGINT','SIGTERM','SIGQUIT'].forEach(sig => {
  try {
    process.on(sig, () => {
      console.log(`[lifecycle] ${sig} received – flushing state & exiting`);
      flushPersistSync();
      process.exit(0);
    });
  } catch {}
});

// Optional manual flush route (can be protected upstream via network ACL / reverse proxy)
app.post('/__flush', (req,res)=>{ flushPersistSync(); res.json({ ok:true, ts:Date.now() }); });

// try load persisted data at startup
loadPersisted();

function ensureTeam(socket){ return socket.handshake.auth?.teamId || socket.id; }

function serializeState(){
  return {
    phase: state.phase,
    currentCategory: state.currentCategory,
    roundIndex: state.roundIndex,
    roundResolved: isRoundResolved(),
    stakes: state.stakes,
    categoryPot: state.categoryPot,
    carryRound: state.carryRound,
    submissions: state.submissions,
    fuchsHistory: state.fuchsHistory || {},
  joinCode: state.joinCode,
  teamLimit: state.teamLimit,

    // Timer
    timerEndsAt: state.timerEndsAt,
    timerDuration: state.timerDuration,
    timerPausedRemaining: state.timerPausedRemaining,
    serverNow: Date.now(),

    // ðŸ¦Œ Elch
    elch: state.elch,

    // ðŸ Race
    raceMode: state.raceMode,
  };
}
function serializeTeams(){ return Array.from(teams.values()).map(t=>({...t})); }

// --- Category Normalization -------------------------------------------------
// Frontend uses the proper Umlaut "Bär". Some earlier backend code had a
// mojibake variant "BÃ¤r" persisted or compared, which prevented submissions
// from being accepted / shown. We normalize any legacy / incoming variants
// to the canonical display form with Umlaut so comparisons stay consistent.
function normalizeCategory(cat){
  if(!cat) return cat;
  if(cat === 'BÃ¤r' || cat === 'Baer' || cat === 'B??r') return 'Bär';
  return cat;
}

function emitState(io){ io.emit('state:update', serializeState()); }
function emitTeams(io){ io.emit('teamsUpdated', serializeTeams()); }
function emitAll(io){ emitState(io); emitTeams(io); }

/* =============================
   Game Logic (export game)
================================*/
export const game = {
  // pull helpers
  sendState(io, socket){ socket.emit('state:update', serializeState()); },
  sendTeams(io, socket){ socket.emit('teamsUpdated', serializeTeams()); },

  // ===== TEAM FLOW =====
  teamJoin(io, socket, { name, avatar }){
  const id = ensureTeam(socket);
  try{ console.log(`[game] teamJoin request from socket=${socket.id} auth=${JSON.stringify(socket.handshake?.auth||{})} -> id=${id} name=${String(name||'')}`); }catch(e){}
    const cleanName = name?.trim();
    // Normalisiere Avatar-Pfad
    if (typeof avatar === 'string') {
      if (!avatar.startsWith('/')) avatar = '/' + avatar; // eslint-disable-line no-param-reassign
    }
    const isValid = typeof avatar === 'string' && AVATAR_POOL.includes(avatar);
    const taken = new Set(Array.from(teams.values()).map(t => t.avatar));

    if (!teams.has(id)) {
      // Neuer Join
      let finalAvatar = null;
      if (isValid && !taken.has(avatar)) {
        finalAvatar = avatar;
      } else {
        // Freien Avatar automatisch wÃ¤hlen
        finalAvatar = AVATAR_POOL.find(a => !taken.has(a)) || AVATAR_POOL[0];
      }
      teams.set(id, {
        id,
        name: cleanName || `Team ${teams.size+1}`,
        avatar: finalAvatar,
        coins: 24,
        quizJoker: 1,
        joinedAt: Date.now(),
      });
    } else {
      // Update vorhandenes Team
      const t = teams.get(id);
      if (cleanName) t.name = cleanName;
      if (isValid && !taken.has(avatar)) t.avatar = avatar;
    }
    emitAll(io);
    markDirty();
    try{ socket.emit('team:welcome', { teamId: id });
      console.log(`[game] emitted team:welcome to socket=${socket.id} teamId=${id}`);
    }catch(e){ console.error('[game] error emitting team:welcome', e); }
  },

  teamSetStake(io, socket, { stake, useJoker }){
    if(state.phase !== 'STAKE') return;
    const id = ensureTeam(socket);
    const t = teams.get(id); if(!t) return;
  // Dynamische Stakes: bei mehr als 2 Teams zusÃ¤tzlich 9 erlauben
  const dynamicValid = state.teamLimit > 2 ? [0,3,6,9] : [0,3,6];
  let s = Number(stake);
  if(!dynamicValid.includes(s)) s = 0;
    if(t.coins < 3 && s > 0) s = 0; // auto 0 bei Bank <3

    const allowJoker = !!useJoker && t.quizJoker > 0 && s > 0;
    state.stakes[id] = { stake: s, useJoker: allowJoker };
    emitState(io);
    markDirty();
  },

  // submissions â€“ generisch; fÃ¼r Elch gibt es Spezialpfad (Buzz)
  teamSubmit(io, socket, category, payload){
    const normCat = normalizeCategory(category);
    if(state.phase!=='CATEGORY' || normalizeCategory(state.currentCategory)!==normCat) return;
    const id = ensureTeam(socket);
    // TIMER GRACE: allow submissions only within 300ms after natural expiry if timer was active
    const GRACE_MS = 300;
    const timerActive = state.timerDuration > 0;
    if(timerActive && !state.timerEndsAt && state.lastTimerEnd){
      const lateBy = Date.now() - state.lastTimerEnd;
      if(lateBy > GRACE_MS){
        // Drop late submission silently (could log if needed)
        return;
      }
    }

    // ðŸ¦Œ ELCH: nur Buzz-Logik, KEIN Textspeichern
    if (normCat === 'Elch' && payload && payload.buzz) {
      if (!state.elch.category) return; // noch keine Sprache gezogen
      const already = state.elch.buzzOrder.some(e => e.teamId === id);
      if (!state.elch.buzzLocked && !already) {
        state.elch.buzzOrder.push({ teamId: id, ts: Date.now() });
        // erster Buzz â†’ sofort locken
        if (state.elch.buzzOrder.length === 1) {
          state.elch.buzzLocked = true;
          state.elch.phase = 'LOCK';
          if(!state.elch.buzzAnswerEndsAt){
            state.elch.buzzAnswerEndsAt = Date.now() + ELCH_ANSWER_WINDOW_MS;
          }
        }
        emitState(io);
      } else if (state.elch.buzzLocked && !already) {
        // Late buzz attempt after lock: inform just that socket who was first
        try {
          const first = state.elch.buzzOrder[0];
          if(first){
            const who = teams.get(first.teamId);
            socket.emit('elch:lateBuzzInfo', { firstTeamName: who?.name || first.teamId, at: first.ts, answerEndsAt: state.elch.buzzAnswerEndsAt });
          } else {
            socket.emit('elch:lateBuzzInfo', { firstTeamName: null, at: null, answerEndsAt: state.elch.buzzAnswerEndsAt });
          }
        } catch {}
      }
      return;
    }

    // Standard-Submit fÃ¼r alle anderen Kategorien
    const prev = state.submissions[id] || {};
    // Basic validation / normalization per category
    if(normCat === 'Bär'){
      if(payload && typeof payload.estimate !== 'number') return; // ignore invalid
      if(payload && typeof payload.estimate === 'number'){
        const v = Number(payload.estimate);
        if(!Number.isFinite(v)) return;
        payload.estimate = v; // eslint-disable-line no-param-reassign
      }
    }
    if(normCat === 'Wal'){
      if(payload && typeof payload.bid === 'number'){
        let b = Math.max(0, Math.min(10_000, Math.round(payload.bid)));
        payload.bid = b; // eslint-disable-line no-param-reassign
      } else if(payload && payload.bid != null) return;
    }
    if(normCat === 'Robbe'){
      if(payload && payload.perc){
        const p = payload.perc; // eslint-disable-line no-param-reassign
        ['a','b','c'].forEach(k=>{ p[k] = Math.max(0, Math.min(100, Math.round(Number(p[k])||0))); });
        const sum = p.a + p.b + p.c;
        if(sum !== 100 && sum > 0){
          const scale = 100 / sum; p.a = Math.round(p.a*scale); p.b = Math.round(p.b*scale); p.c = Math.max(0, 100 - (p.a + p.b));
        }
      }
    }
    const next = { ...prev, ...payload, ts: Date.now() };
    state.submissions[id] = next;
    logEvent('submit.store', { category: normCat, team:id, keys:Object.keys(payload||{}) });
    emitState(io);
    markDirty();
  },

  // ===== ADMIN FLOW =====
  adminResume(io, socket){
    socket.emit('state:update', serializeState());
    socket.emit('teamsUpdated', serializeTeams());
  },

  adminTeamUpdate(io, { id, ...patch }){
    const t = teams.get(id); if(!t) return;
    if(typeof patch.coins === 'number') t.coins = patch.coins;
    if(typeof patch.quizJoker === 'number') t.quizJoker = patch.quizJoker;
    if(typeof patch.name === 'string') t.name = patch.name;
    if(typeof patch.avatar === 'string') t.avatar = patch.avatar;
    emitTeams(io);
    markDirty();
  },

  adminTeamKick(io, { id }){
    if(!id || !teams.has(id)) return;
    logEvent('admin.team.kick', { id });
    // Remove team
    teams.delete(id);
    // Clean related state: stakes, submissions, earnings, roundWins, elch buzz order entries
    try { delete state.stakes[id]; } catch {}
    try { delete state.submissions[id]; } catch {}
    try { delete state.categoryEarnings[id]; } catch {}
    try { delete state.roundWins[id]; } catch {}
    try {
      if(Array.isArray(state.elch?.buzzOrder)){
        state.elch.buzzOrder = state.elch.buzzOrder.filter(b=> b.teamId !== id);
      }
    } catch {}
    emitAll(io);
    markDirty();
  },

  adminStartCategory(io, { category }){
    logEvent('admin.category.start', { category });
    state.phase = 'STAKE';
    state.currentCategory = normalizeCategory(category);
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
  state.roundWins = {};
  state.categoryEarnings = {};
    state.resolvedRounds = Object.create(null);

    // ðŸ¦Œ Elch init, falls Elch gestartet wird
    state.elch = {
      category: null,
      used: [],
      buzzOrder: [],
      buzzLocked: false,
      exhausted: false,
      phase: 'IDLE',
      buzzAnswerEndsAt: null,
    };

    if(category === 'Elch'){
      // Auto choose fixed category for round 0
      const fixed = [
        { round:0, primary:'Städte', fallback:'Berufe' },
        { round:1, primary:'Tiere', fallback:'Marken' },
        { round:2, primary:'Länder', fallback:'Dinge aus der Küche' },
      ];
      const cfg = fixed.find(r=>r.round === state.roundIndex) || fixed[0];
      let pick = cfg.primary;
      if(state.elch.used.includes(pick)) pick = cfg.fallback;
      if(state.elch.used.includes(pick)){
        state.elch.exhausted = true;
        state.elch.category = null;
        state.elch.phase = 'LOCK';
      } else {
        state.elch.category = pick;
        state.elch.used.push(pick);
        state.elch.phase = 'BUZZ_READY';
        state.elch.buzzAnswerEndsAt = null;
      }
    }

    emitAll(io);
    markDirty();
  },

  // Admin: Anzahl aktiver Teams setzen (2..5)
  adminSetTeamLimit(io, { limit }){
    const n = Math.max(2, Math.min(5, Number(limit)||3));
    if(n !== state.teamLimit){
      state.teamLimit = n;
      emitState(io);
      markDirty();
      logEvent('admin.teamLimit.set', { limit:n });
    }
  },

  adminLockStakes(io){
    logEvent('admin.stakes.lock', { potPreview: state.categoryPot });
    // EinsÃ¤tze abbuchen & Joker verbrauchen
    for(const [tid, s] of Object.entries(state.stakes)){
      const t = teams.get(tid); if(!t) continue;
      t.coins = Math.max(0, t.coins - (s.stake||0)); // Einsatz
      if(s.useJoker) t.quizJoker = 0;
    }
    // JokerExtra +3 Bank
    const sumEinsatz = Object.values(state.stakes).reduce((a,s)=>a+(s.stake||0),0);
    const jokerExtra = Object.values(state.stakes).reduce((a,s)=>a+(s.useJoker?(s.stake||0):0),0);
    state.categoryPot = sumEinsatz + jokerExtra + 3;
    state.phase = 'CATEGORY';
    emitAll(io);
    markDirty();
  },

  adminResolveRound(io, { winnerId, winnerIds }) {
    if(state.phase!=='CATEGORY') return;
    if (isRoundResolved()) return;
    logEvent('admin.round.resolve.attempt', { winnerId, winnerIdsCount: Array.isArray(winnerIds)?winnerIds.length:0 });
    const payout = Math.floor(state.categoryPot / ROUNDS_PER_CATEGORY); // CP/3
    const chosenRaw = Array.isArray(winnerIds) ? winnerIds : [];
    const uniqueIds = [...new Set(chosenRaw.filter(id => id !== null && id !== undefined).map(id => String(id)))].filter(id => teams.has(id));
    const totalPot = payout + state.carryRound;
    let resolved = false;
    let resolvedWinnerId = null;
    let resolvedWinnerIds = [];

    let tieShare = null; // track actual per-team share for tie (without remainder)
    if (uniqueIds.length > 1) {
      // Neue Logik: Gleichstand -> alle erhalten floor(totalPot / n); Rest (Remainder) geht als Carry weiter
      const n = uniqueIds.length;
      const share = n ? Math.floor(totalPot / n) : 0;
      const remainder = n ? (totalPot - share * n) : 0;
      uniqueIds.forEach((id) => {
        const team = teams.get(id);
        if (!team) return;
        const gain = share;
        team.coins += gain;
        state.roundWins[id] = (state.roundWins[id]||0) + 1;
        state.categoryEarnings[id] = (state.categoryEarnings[id]||0) + gain;
      });
      tieShare = share;
      // Remainder wird nur getragen, wenn es weitere Runden in dieser Kategorie gibt
      if (state.roundIndex < ROUNDS_PER_CATEGORY - 1) {
        state.carryRound += remainder; // add leftover to carry
      } else {
        // letzte Runde -> remainder verfällt (oder könnte hier global geloggt werden)
        if (remainder > 0) logEvent('round.tie.remainder.discarded', { remainder, category: state.currentCategory });
      }
      resolved = true;
      resolvedWinnerIds = uniqueIds;
    } else {
      const rawSingle = uniqueIds.length === 1 ? uniqueIds[0] : winnerId;
      const singleId = rawSingle !== null && rawSingle !== undefined ? String(rawSingle) : null;
      if (singleId && teams.has(singleId)) {
        const team = teams.get(singleId);
        if (team) {
          const gain = totalPot;
          team.coins += gain;
          state.carryRound = 0;
          state.roundWins[singleId] = (state.roundWins[singleId]||0) + 1;
          state.categoryEarnings[singleId] = (state.categoryEarnings[singleId]||0) + gain;
          resolved = true;
          resolvedWinnerId = singleId;
          resolvedWinnerIds = [singleId];
        }
      } else if (winnerId === null) {
        state.carryRound += payout; // rollt weiter
        resolved = true;
      }
    }

    if (resolved) {
      markRoundResolved(true);
      // Store pending result; emission happens on explicit admin:round:end
      state.pendingResult = {
        winnerId: resolvedWinnerId,
        winnerIds: resolvedWinnerIds,
        category: state.currentCategory,
        roundIndex: state.roundIndex,
        payout,
        carry: state.carryRound,
        // Für Frontend: pro Gewinner (tie) der erhaltene Anteil (ohne Remainder-Verteilung)
        tiePayouts: (resolvedWinnerIds && resolvedWinnerIds.length>1 && tieShare!=null) ? resolvedWinnerIds.reduce((acc,id)=>{ acc[id]=tieShare; return acc; }, {}) : null,
        // Für Carry-Fall: zeige was übertragen wurde (damit UI Münzen/Carry kontext hat)
        carriedAmount: (resolvedWinnerId==null && (!resolvedWinnerIds || resolvedWinnerIds.length===0) && state.carryRound>0) ? state.carryRound : 0,
        at: Date.now(),
      };
      emitState(io); // update roundResolved flag for clients
      emitPendingResult(io);
      markDirty();
    }
  },

  adminRoundEnd(io, { roundIndex, category }){
    // Only emit if we have a pending result matching current round
    if(!state.pendingResult) return;
    if(state.pendingResult.category !== state.currentCategory) return;
    if(state.pendingResult.roundIndex !== state.roundIndex) return;
    // Build recap lazily
    const recap = (()=>{
      const cat = state.currentCategory;
      const subs = state.submissions || {};
      const base = { category: cat, roundIndex: state.roundIndex, submissions: subs };
      try {
        if(cat === 'Robbe') base.correctKey = null;
        else if(cat === 'Bär') base.solution = null;
        else if(cat === 'Wal') base.note = 'Gebote';
        else if(cat === 'Fuchs') base.note = 'Mehrfachversuche möglich';
      } catch {}
      return base;
    })();
    io.emit('result:announce', { ...state.pendingResult, recap });
    state.pendingResult = null; // clear so we don't re-announce automatically
    markDirty();
  },

  adminRoundUndo(io, { snapshot }) {
    if (state.phase !== 'CATEGORY') return;
    if (!isRoundResolved()) return;
    const snap = snapshot || {};
    const { coins: coinMap, carryRound } = snap;
    if (coinMap && typeof coinMap === 'object') {
      Object.entries(coinMap).forEach(([teamId, value]) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && teams.has(teamId)) {
          teams.get(teamId).coins = Math.max(0, Math.floor(parsed));
        }
      });
      emitTeams(io);
    }
    if (Number.isFinite(carryRound)) {
      state.carryRound = Math.max(0, Math.floor(carryRound));
    }
    const last = state.pendingResult && state.pendingResult.category === state.currentCategory && state.pendingResult.roundIndex === state.roundIndex
      ? state.pendingResult
      : (state.lastResult && state.lastResult.category === state.currentCategory && state.lastResult.roundIndex === state.roundIndex ? state.lastResult : null);
    if (last) {
      const winners = Array.isArray(last.winnerIds) && last.winnerIds.length ? last.winnerIds : (last.winnerId != null ? [last.winnerId] : []);
      winners.forEach((id) => {
        if (state.roundWins[id]) state.roundWins[id] = Math.max(0, state.roundWins[id] - 1);
        const gain = last.tiePayouts && last.tiePayouts[id] != null
          ? last.tiePayouts[id]
          : (last.winnerId === id ? (last.payout + (last.carry || 0)) : 0);
        if (gain && state.categoryEarnings[id]) {
          state.categoryEarnings[id] = Math.max(0, state.categoryEarnings[id] - gain);
        }
      });
    }
    state.pendingResult = null;
    state.lastResult = null;
    markRoundResolved(false);
    emitState(io);
    markDirty();
  },

  adminRoundNext(io){
    if(state.phase!=='CATEGORY') return;
    logEvent('admin.round.next', { from: state.roundIndex });
    state.pendingResult = null;
    state.lastResult = null;
    markRoundResolved(false);
    state.roundIndex = Math.min(ROUNDS_PER_CATEGORY-1, state.roundIndex+1);
    state.submissions = {}; // neue Runde

    // ðŸ¦Œ Elch: neue Runde â†’ Buzz zurÃ¼cksetzen, Buzz freigeben, Kategorie bleibt (Admin kann neu ziehen)
    if (state.currentCategory === 'Elch') {
      state.elch.buzzOrder = [];
      state.elch.buzzLocked = false;
      const fixed = [
        { round:0, primary:'Städte', fallback:'Berufe' },
        { round:1, primary:'Tiere', fallback:'Marken' },
        { round:2, primary:'Länder', fallback:'Dinge aus der Küche' },
      ];
      const cfg = fixed.find(r=>r.round === state.roundIndex) || fixed[0];
      let pick = cfg.primary;
      if(state.elch.used.includes(pick)) pick = cfg.fallback;
      if(state.elch.used.includes(pick)){
        state.elch.exhausted = true;
        state.elch.category = null;
        state.elch.phase = 'LOCK';
      } else {
        state.elch.category = pick;
        state.elch.used.push(pick);
        state.elch.phase = 'BUZZ_READY';
        state.elch.buzzAnswerEndsAt = null;
      }
    }

    emitState(io);
    markDirty();
  },

  adminRoundPrev(io){
    if(state.phase!=='CATEGORY') return;
    logEvent('admin.round.prev', { from: state.roundIndex });
    state.pendingResult = null;
    state.lastResult = null;
    markRoundResolved(false);
    state.roundIndex = Math.max(0, state.roundIndex-1);
    state.submissions = {};
    // Elch-Buzz leeren um Verwirrung zu vermeiden & Sprache freigeben (erneut ziehen mÃ¶glich)
    if (state.currentCategory === 'Elch') {
      state.elch.buzzOrder = [];
      state.elch.buzzLocked = false;
      const fixed = [
        { round:0, primary:'Städte', fallback:'Berufe' },
        { round:1, primary:'Tiere', fallback:'Marken' },
        { round:2, primary:'Länder', fallback:'Dinge aus der Küche' },
      ];
      const cfg = fixed.find(r=>r.round === state.roundIndex) || fixed[0];
      let pick = cfg.primary;
      if(state.elch.used.includes(pick)) pick = cfg.fallback;
      if(state.elch.used.includes(pick)){
        state.elch.exhausted = true;
        state.elch.category = null;
        state.elch.phase = 'LOCK';
      } else {
        state.elch.category = pick;
        state.elch.used.push(pick);
        state.elch.phase = 'BUZZ_READY';
        state.elch.buzzAnswerEndsAt = null;
      }
    }
    emitState(io);
    markDirty();
  },

  adminFinishCategory(io){
    logEvent('admin.category.finish', { category: state.currentCategory, rounds: state.roundIndex+1 });
    // Zusammenfassung vor Reset merken
    const summary = {
      category: state.currentCategory,
      // coins gewonnen pro Team (nur Gewinne, EinsÃ¤tze nicht berÃ¼cksichtigt)
      earnings: { ...state.categoryEarnings },
      pot: state.categoryPot,
      roundsPlayed: state.roundIndex + 1,
      carryOverUnused: state.carryRound,
      timestamp: Date.now(),
    };
    io.emit('category:summary', summary);

    state.phase = 'LOBBY';
    state.currentCategory = null;
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
    state.roundWins = {};
    state.categoryEarnings = {};
    state.resolvedRounds = Object.create(null);
    state.pendingResult = null;
    state.lastResult = null;

    // Elch komplett zurÃ¼cksetzen
    state.elch = {
      category: null,
      used: [],
      buzzOrder: [],
      buzzLocked: false,
      exhausted: false,
      phase: 'IDLE',
      buzzAnswerEndsAt: null,
    };
  // Join-Code behalten (Lobby)

    emitAll(io);
  markDirty();
  },

  // Nur zur Lobby wechseln OHNE Zusammenfassung zu senden (Abbruch)
  adminGotoLobby(io){
    logEvent('admin.goto.lobby', { prevCategory: state.currentCategory });
    state.phase = 'LOBBY';
    state.currentCategory = null;
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
    state.roundWins = {};
    state.categoryEarnings = {};
    state.resolvedRounds = Object.create(null);
    state.pendingResult = null;
    state.lastResult = null;
  state.elch = { category:null, used:[], buzzOrder:[], buzzLocked:false, exhausted:false, phase:'IDLE', buzzAnswerEndsAt:null };
    emitAll(io);
    markDirty();
  },

  // ===== TIMER =====
  adminTimerStart(io, { seconds }){
    const s = Math.max(1, Math.min(999, Number(seconds)||0));
    logEvent('admin.timer.start', { seconds:s });
    state.timerDuration = s;
    state.timerEndsAt = Date.now() + s*1000;
    state.timerPausedRemaining = 0;
    state.lastTimerEnd = null; // reset previous expiry marker
    emitState(io);
    markDirty();
  },
  adminTimerStop(io){
    logEvent('admin.timer.stop', { remaining: state.timerEndsAt ? state.timerEndsAt - Date.now() : null });
    // compute remaining seconds and store it separately to show frozen bar
    if (state.timerEndsAt) {
      const remaining = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
      state.timerPausedRemaining = remaining;
    }
    state.timerEndsAt = null;
  // behalten, damit Resume mÃ¶glich
    emitState(io);
    markDirty();
  },
  adminTimerReset(io){
    logEvent('admin.timer.reset', {});
    state.timerEndsAt = null;
    state.timerDuration = 0;
    state.timerPausedRemaining = 0;
    emitState(io);
    markDirty();
  },
  adminTimerResume(io){
    if (!state.timerEndsAt && state.timerPausedRemaining > 0) {
      const s = Math.max(1, Number(state.timerPausedRemaining) || 0);
      logEvent('admin.timer.resume', { seconds:s });
      state.timerEndsAt = Date.now() + s * 1000;
      // keep timerDuration as original total to preserve bar ratio
      state.timerPausedRemaining = 0;
      emitState(io);
      markDirty();
    }
  },

  // ===== ðŸ¦Œ ELCH ADMIN =====
  adminElchDraw(io){
    if (state.currentCategory !== 'Elch') return;
    logEvent('admin.elch.draw', { round: state.roundIndex, mode:'fixed-toggle' });
    const fixed = [
      { round:0, primary:'Städte', fallback:'Berufe' },
      { round:1, primary:'Tiere', fallback:'Marken' },
      { round:2, primary:'Länder', fallback:'Dinge aus der Küche' },
    ];
    const cfg = fixed.find(r=>r.round === state.roundIndex) || fixed[0];
    // Always (re)start with primary on explicit draw
    state.elch.category = cfg.primary;
    if(!state.elch.used.includes(cfg.primary)) state.elch.used.push(cfg.primary);
    state.elch.exhausted = false; // never exhaust in toggle model
    state.elch.buzzOrder = [];
    state.elch.buzzLocked = false;
    state.elch.phase = 'BUZZ_READY';
    state.elch.buzzAnswerEndsAt = null;
    emitState(io);
  },

  adminElchSetLock(io, { locked }){
    if (state.currentCategory !== 'Elch') return;
    state.elch.buzzLocked = !!locked;
    if(locked) state.elch.phase = 'LOCK';
    emitState(io);
    logEvent('admin.elch.setLock', { locked });
  },

  adminElchClearBuzz(io){
    if (state.currentCategory !== 'Elch') return;
    logEvent('admin.elch.clearBuzz', {});
    state.elch.buzzOrder = [];
    state.elch.buzzLocked = false;
    // Toggle logic: alternate primary/fallback each clear, never exhaust.
    const fixed = [
      { round:0, primary:'Städte', fallback:'Berufe' },
      { round:1, primary:'Tiere', fallback:'Marken' },
      { round:2, primary:'Länder', fallback:'Dinge aus der Küche' },
    ];
    const cfg = fixed.find(r=>r.round === state.roundIndex) || fixed[0];
    const cur = state.elch.category;
    if(cur === cfg.primary){
      state.elch.category = cfg.fallback;
      if(!state.elch.used.includes(cfg.fallback)) state.elch.used.push(cfg.fallback);
    } else {
      state.elch.category = cfg.primary;
      if(!state.elch.used.includes(cfg.primary)) state.elch.used.push(cfg.primary);
    }
    state.elch.exhausted = false;
    state.elch.phase = 'BUZZ_READY';
    state.elch.buzzAnswerEndsAt = null;
    emitState(io);
  },
  adminElchConfirm(io, { teamId } = {}){
    if (state.currentCategory !== 'Elch') return;
    if (state.phase !== 'CATEGORY') return;
    if (isRoundResolved()) return;
    const buzzOrder = Array.isArray(state.elch?.buzzOrder) ? state.elch.buzzOrder : [];
    const first = buzzOrder[0];
    const normalizedTeamId = teamId != null ? String(teamId) : null;
    const winnerId = (normalizedTeamId && teams.has(normalizedTeamId))
      ? normalizedTeamId
      : (first ? String(first.teamId) : null);
    if (!winnerId || !teams.has(winnerId)) return;
    logEvent('admin.elch.confirm', { winnerId, providedTeamId: normalizedTeamId, round: state.roundIndex });
    state.elch.buzzAnswerEndsAt = null;
    state.elch.phase = 'LOCK';
    state.elch.buzzLocked = true;
    game.adminResolveRound(io, { winnerId });
  },
  // Unlock only (keeps current category) -> allow new buzz attempt same category
  adminElchUnlock(io){
    if (state.currentCategory !== 'Elch') return;
    if(state.elch.exhausted) return;
    logEvent('admin.elch.unlock', {});
    state.elch.buzzOrder = [];
    state.elch.buzzLocked = false;
    state.elch.phase = 'BUZZ_READY';
    state.elch.buzzAnswerEndsAt = null;
    emitState(io);
  },

  // ===== ðŸ RACE MODE (Scoreboard) =====
  adminRaceSet(io, { mode }){
    const m = String(mode||'').toUpperCase();
    if (!['PRE','RACE','POST','FINAL'].includes(m)) return;
    state.raceMode = m;
    // Auto-advance from RACE -> POST after animation window
    clearTimeout(raceAutoTmo);
    if (m === 'RACE') {
      // 12s: Countdown (~2.8s) + Animation (~9s) + Puffer
      raceAutoTmo = setTimeout(() => {
        state.raceMode = 'POST';
        emitState(io);
        markDirty();
      }, 12000);
    }
    emitState(io);
    markDirty();
  },
  // (Aliase, falls du einfache Buttons nutzt)
  adminRaceShow(io){ game.adminRaceSet(io, { mode: 'RACE' }); },
  adminRaceHide(io){ game.adminRaceSet(io, { mode: 'POST' }); },
  adminRaceToggle(io){
    const m = state.raceMode === 'RACE' ? 'POST' : 'RACE';
    game.adminRaceSet(io, { mode: m });
  },

  // ===== FULL RESET (Scores & State) =====
  adminResetAll(io){
    // Reset game state
    state.phase = 'LOBBY';
    state.currentCategory = null;
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
    state.timerEndsAt = null;
    state.timerDuration = 0;
    state.timerPausedRemaining = 0;
    state.elch = { category:null, used:[], buzzOrder:[], buzzLocked:false, exhausted:false };
    state.raceMode = 'POST';
  state.joinCode = null;
  // Optional: alle Teams rauswerfen, damit Slots wieder frei werden
  // (statt nur Coins/Joker zurÃ¼cksetzen)
  teams.clear();
    // Inform clients about the hard reset so they can re-request/join
    io.emit('server:reset');
  // Falls du stattdessen nur zurÃ¼cksetzen willst, entferne die Zeile oben und nutze untenstehenden Loop
  // for(const t of teams.values()){ t.coins = 24; t.quizJoker = 1; }
    emitAll(io);
    markDirty();
  },
};

/* =============================
   Socket.IO Routing
================================*/
io.on('connection', (socket) => {
  try { console.log(`ðŸ”Œ Socket connected: ${socket.id} from ${socket.handshake.address}`); } catch(e){}
  // Pull
  socket.on('requestState', () => game.sendState(io, socket));
  socket.on('requestTeams', () => game.sendTeams(io, socket));

  // Team
  socket.on('team:join', (p) => game.teamJoin(io, socket, p));
  socket.on('team:setStake', (p = {}) => {
    if(isDuplicateAction(p.actionId)) return;
    game.teamSetStake(io, socket, p);
  });

  // Submissions
  const dupGuard = (cat, transform) => (p = {}) => {
    if(isDuplicateAction(p.actionId)) return;
    game.teamSubmit(io, socket, cat, transform ? transform(p) : p);
  };
  socket.on('team:hase:submit',    (p,cb)=>{ dupGuard('Hase')(p); cb && cb('ok'); logEvent('submit.hase',{actionId:p?.actionId, team:ensureTeam(socket)}); });
  socket.on('team:kranich:submit', (p,cb)=>{ dupGuard('Kranich')(p); cb && cb('ok'); logEvent('submit.kranich',{actionId:p?.actionId, team:ensureTeam(socket)}); });
  socket.on('team:robbe:submit',   (p,cb)=>{ dupGuard('Robbe')(p); cb && cb('ok'); logEvent('submit.robbe',{actionId:p?.actionId, team:ensureTeam(socket)}); });
  socket.on('team:eule:submit',    (p,cb)=>{ dupGuard('Eule')(p); cb && cb('ok'); logEvent('submit.eule',{actionId:p?.actionId, team:ensureTeam(socket)}); });
  socket.on('team:wal:submit',     (p,cb)=>{ dupGuard('Wal')(p); cb && cb('ok'); logEvent('submit.wal',{actionId:p?.actionId, team:ensureTeam(socket)}); });
  socket.on('team:elch:buzz',      () => { if(isDuplicateAction(socket.id+':elchBuzz')) return; game.teamSubmit(io, socket, 'Elch', { buzz:true }); });
  socket.on('team:elch:submit',    ()=> {/* ignoriert – Elch antwortet laut */});
  socket.on('team:baer:submit',    (p,cb)=>{ dupGuard('Bär')(p); cb && cb('ok'); logEvent('submit.baer',{actionId:p?.actionId, team:ensureTeam(socket)}); });
  socket.on('team:fuchs:submit',   (p,cb)=>{ 
    const id = ensureTeam(socket);
    const val = (p?.guess || '').trim();
    if(val){
      if(!state.fuchsHistory) state.fuchsHistory = {};
      if(!state.fuchsHistory[id]) state.fuchsHistory[id] = [];
      const hist = state.fuchsHistory[id];
      const last = hist[hist.length-1];
      if(!last || last.guess !== val){
        hist.push({ guess: val, ts: Date.now() });
        if(hist.length > 50) hist.splice(0, hist.length - 50); // etwas höheres Limit hier
      }
    }
    dupGuard('Fuchs')(p); 
    cb && cb('ok'); 
    logEvent('submit.fuchs',{actionId:p?.actionId, team:ensureTeam(socket)});
    emitState(io);
  });

  // Admin
  socket.on('admin:resume', () => game.adminResume(io, socket));
  socket.on('admin:team:update', (p) => game.adminTeamUpdate(io, p));
  socket.on('admin:team:kick', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminTeamKick(io, p); });
  socket.on('admin:category:start', (p) => game.adminStartCategory(io, p));
  socket.on('admin:category:start', () => { state.fuchsHistory = {}; state.submissions = {}; emitState(io); });
  socket.on('admin:stakes:lock', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminLockStakes(io); });
  socket.on('admin:round:resolve', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminResolveRound(io, p); });
  socket.on('admin:round:end', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminRoundEnd(io, p); });
  socket.on('admin:round:undo', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminRoundUndo(io, p); });
  socket.on('admin:round:next', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminRoundNext(io); });
  // After round increment, clear per-round free-entry history
  socket.on('admin:round:next', () => { state.fuchsHistory = {}; state.submissions = {}; emitState(io); });
  socket.on('admin:round:prev', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminRoundPrev(io); });
  socket.on('admin:round:prev', () => { state.fuchsHistory = {}; state.submissions = {}; emitState(io); });
  socket.on('admin:category:finish', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminFinishCategory(io); });
  socket.on('admin:category:finish', () => { state.fuchsHistory = {}; state.submissions = {}; emitState(io); });
  socket.on('admin:lobby', () => game.adminGotoLobby(io));

  // Timer
  socket.on('admin:timer:start', (p) => game.adminTimerStart(io, p));
  socket.on('admin:timer:stop',  () => game.adminTimerStop(io));
  socket.on('admin:timer:reset', () => game.adminTimerReset(io));
  socket.on('admin:timer:resume', () => game.adminTimerResume(io));

  // ðŸ¦Œ Elch (Admin)
  socket.on('admin:elch:draw',      () => game.adminElchDraw(io));
  socket.on('admin:elch:setLock',   (p) => game.adminElchSetLock(io, p)); // {locked:boolean}
  socket.on('admin:elch:clearBuzz', () => game.adminElchClearBuzz(io));
  socket.on('admin:elch:confirm',   (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminElchConfirm(io, p); });
  socket.on('admin:elch:unlock', () => game.adminElchUnlock(io));

  // ðŸ“Š Scoreboard V2 controls (forward Admin â†’ all clients)
  socket.on('scoreboard:v2:run',     (p) => io.emit('scoreboard:v2:run', p));
  socket.on('scoreboard:v2:mode',    (p) => io.emit('scoreboard:v2:mode', p));
  // removed: scoreboard:v2:countup and :replay â€“ CountUp auto-triggers after stacking; replay dropped
  socket.on('scoreboard:v2:arm',     () => io.emit('scoreboard:v2:arm'));
  socket.on('scoreboard:v2:start',   (p) => io.emit('scoreboard:v2:start', p));

  // ðŸ Race (Scoreboard)
  socket.on('admin:race:set',   (p) => game.adminRaceSet(io, p));  // {mode:'PRE'|'RACE'|'POST'}
  socket.on('admin:race:show',  () => game.adminRaceShow(io));     // alias â†’ 'RACE'
  socket.on('admin:race:hide',  () => game.adminRaceHide(io));     // alias â†’ 'POST'
  socket.on('admin:race:toggle',() => game.adminRaceToggle(io));   // alias toggle

  // Team-Limit setzen
  socket.on('admin:teamLimit:set', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminSetTeamLimit(io, p); });

  // Full reset (scores & state)
  socket.on('admin:reset:all', (p={}) => { if(isDuplicateAction(p.actionId)) return; game.adminResetAll(io); });
});

// additional logging for disconnects
io.on('disconnect', (reason) => {
  try { console.log('ðŸ”Œ Socket.IO server disconnect event', reason); } catch(e){}
});

// Timer-Tick fÃ¼r automatische Submits bei Ablauf
setInterval(() => {
  if (
    state.phase === 'CATEGORY' &&
    state.timerEndsAt &&
    Date.now() >= state.timerEndsAt
  ) {
    // Timer abgelaufen
    const expiredAt = state.timerEndsAt; // capture
    state.timerEndsAt = null;
    state.lastTimerEnd = expiredAt; // record natural expiry
    // Automatisch alle vorhandenen Antworten als Submission Ã¼bernehmen (falls nicht schon geschehen)
    // (Hier: keine neuen Daten, sondern vorhandene submissions bleiben, aber du kÃ¶nntest hier z.B. "locked" setzen)
    // Optional: Du kÃ¶nntest hier auch ein Feld "locked: true" setzen oder ein Event schicken
    emitState(io);
  }
}, 300);

// Auto-unlock Elch after answer window expiry if not resolved
setInterval(() => {
  if(state.phase==='CATEGORY' && state.currentCategory==='Elch'){
    if(state.elch.buzzAnswerEndsAt && Date.now() > state.elch.buzzAnswerEndsAt){
      // Only auto-unlock if round not resolved yet and no explicit resolve
      if(!isRoundResolved()){
        state.elch.buzzLocked = false;
        state.elch.phase = 'BUZZ_READY';
        state.elch.buzzOrder = [];
        state.elch.buzzAnswerEndsAt = null;
        emitState(io);
      }
    }
  }
}, 1000);

const PORT = Number(process.env.PORT) || 3001;

server.listen(PORT, () => console.log(`âœ… Backend auf http://localhost:${PORT}`));

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`
Error: Port ${PORT} is already in use.
Either stop the process listening on that port or set a different port via the PORT environment variable.
For example (Powershell):
  $pid = (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess; if ($pid) { Stop-Process -Id $pid -Force }
Or start the backend on another port and update the frontend socket URL at frontend/src/socket.js accordingly.
`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  next();
});

// Lightweight health/root endpoint to avoid 404 in browsers when the backend
// origin is probed (helps when Cloudflare routes the domain to this server).
app.get('/', (req, res) => {
  res.status(200).send('<!doctype html><html><head><meta charset="utf-8"><title>Cozy Quiz API</title></head><body>Cozy Quiz API is running.</body></html>');
});

// Catch-all logging for unknown HTTP requests to help debug missing assets/routes.
// Logs method + originalUrl so you can see exactly what the browser requested.
app.use((req, res) => {
  try {
    console.warn(`Unhandled HTTP request: ${req.method} ${req.originalUrl} from ${req.ip || req.connection?.remoteAddress}`);
  } catch (e) {}
  res.status(404).send(`Cannot GET ${req.originalUrl}`);
});

/* =============================
   Join-Code (Lobby) â€“ Admin Events
============================= */
function genJoinCode(){
  // 6-stellig, kein fÃ¼hrendes 0-only Muster
  let c = String(Math.floor(100000 + Math.random()*900000));
  return c;
}

io.on('connection', (socket) => {
  // Admin kann Lobby â€žarmenâ€œ: Code erzeugen und an Screen senden
  socket.on('admin:lobby:arm', () => {
    state.joinCode = genJoinCode();
    emitState(io);
    io.emit('lobby:armed', { code: state.joinCode });
    markDirty();
  });
  socket.on('admin:lobby:newcode', () => {
    state.joinCode = genJoinCode();
    emitState(io);
    io.emit('lobby:armed', { code: state.joinCode });
    markDirty();
  });
  socket.on('requestJoinCode', ()=>{
    if(state.joinCode) socket.emit('lobby:armed', { code: state.joinCode });
  });
});

