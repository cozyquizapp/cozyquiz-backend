// backend/server.js
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
  // LOBBY / Join-Code für QR (Produktion)
  joinCode: null,            // z.B. '482913'
  // Anzahl aktiver Teams (erste N join order) – konfigurierbar (2..5)
  teamLimit: 3,

  // Timer
  timerEndsAt: null,         // ms epoch (server time)
  timerDuration: 0,          // seconds (duration of current/last started countdown)
  timerPausedRemaining: 0,   // seconds remaining when paused (0 when running or reset)

  // 🦌 Elch – Kategoriesprache & Buzz
  elch: {
    category: null,          // z.B. "Tiere"
    used: [],                // bereits gezogene Sprachen
    buzzOrder: [],           // [{teamId, ts}]
    buzzLocked: false,       // true = Buzz gesperrt
    exhausted: false,        // true = alle Sprachen verbraucht
  },

  // 🏁 Scoreboard-Race (PRE → RACE → POST)
  raceMode: 'POST',          // 'PRE' | 'RACE' | 'POST'

  // 📊 Kategorie-Rundensiege (teamId -> count) während laufender Kategorie
  roundWins: {},
  // 💰 Kategorie-Earnings (coin-Gewinne pro Team nur für diese Kategorie)
  categoryEarnings: {},
};

const teams = new Map();     // teamId -> { id,name,avatar,coins,quizJoker,joinedAt }

// Verfügbare Avatar-Dateipfade (müssen mit frontend/public/avatars übereinstimmen)
const AVATAR_POOL = [
  '/avatars/seekuh.png','/avatars/waschbaer.png','/avatars/roter_panda.png','/avatars/igel.png','/avatars/faultier.png','/avatars/einhorn.png','/avatars/eichhoernchen.png','/avatars/capybara.png','/avatars/wombat.png','/avatars/koala.png','/avatars/alpaka.png','/avatars/pinguin.png','/avatars/otter.png','/avatars/giraffe.png','/avatars/eisbaer.png','/avatars/drache.png','/avatars/katze.png','/avatars/hund.png'
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

// try load persisted data at startup
loadPersisted();

function ensureTeam(socket){ return socket.handshake.auth?.teamId || socket.id; }

function serializeState(){
  return {
    phase: state.phase,
    currentCategory: state.currentCategory,
    roundIndex: state.roundIndex,
    stakes: state.stakes,
    categoryPot: state.categoryPot,
    carryRound: state.carryRound,
    submissions: state.submissions,
    roundResolved: isCurrentRoundResolved(),
  joinCode: state.joinCode,
  teamLimit: state.teamLimit,

    // Timer
    timerEndsAt: state.timerEndsAt,
    timerDuration: state.timerDuration,
    timerPausedRemaining: state.timerPausedRemaining,
    serverNow: Date.now(),

    // 🦌 Elch
    elch: state.elch,

    // 🏁 Race
    raceMode: state.raceMode,
  };
}
function serializeTeams(){ return Array.from(teams.values()).map(t=>({...t})); }

function currentRoundKey(){
  if (state.currentCategory == null) return null;
  return :;
}
function isCurrentRoundResolved(){
  const key = currentRoundKey();
  return key ? !!state.resolvedRounds[key] : false;
}
function setCurrentRoundResolved(flag){
  const key = currentRoundKey();
  if (!key) return;
  if (flag) {
    state.resolvedRounds[key] = true;
  } else {
    delete state.resolvedRounds[key];
  }
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
        // Freien Avatar automatisch wählen
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
  // Dynamische Stakes: bei mehr als 2 Teams zusätzlich 9 erlauben
  const dynamicValid = state.teamLimit > 2 ? [0,3,6,9] : [0,3,6];
  let s = Number(stake);
  if(!dynamicValid.includes(s)) s = 0;
    if(t.coins < 3 && s > 0) s = 0; // auto 0 bei Bank <3

    const allowJoker = !!useJoker && t.quizJoker > 0 && s > 0;
    state.stakes[id] = { stake: s, useJoker: allowJoker };
    emitState(io);
    markDirty();
  },

  // submissions – generisch; für Elch gibt es Spezialpfad (Buzz)
  teamSubmit(io, socket, category, payload){
    if(state.phase!=='CATEGORY' || state.currentCategory!==category) return;
    const id = ensureTeam(socket);

    // 🦌 ELCH: nur Buzz-Logik, KEIN Textspeichern
    if (category === 'Elch' && payload && payload.buzz) {
      if (!state.elch.category) return; // noch keine Sprache gezogen
      const already = state.elch.buzzOrder.some(e => e.teamId === id);
      if (!state.elch.buzzLocked && !already) {
        state.elch.buzzOrder.push({ teamId: id, ts: Date.now() });
        // erster Buzz → sofort locken
        if (state.elch.buzzOrder.length === 1) state.elch.buzzLocked = true;
        emitState(io);
      }
      return;
    }

    // Standard-Submit für alle anderen Kategorien
    const prev = state.submissions[id] || {};
    const next = { ...prev, ...payload, ts: Date.now() };
    state.submissions[id] = next;
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

  adminStartCategory(io, { category }){
    state.phase = 'STAKE';
    state.currentCategory = category;
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
  state.roundWins = {};
  state.categoryEarnings = {};

    // 🦌 Elch init, falls Elch gestartet wird
    state.elch = {
      category: null,
      used: [],
      buzzOrder: [],
      buzzLocked: false,
      exhausted: false,
    };

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
    }
  },

  adminLockStakes(io){
    // Einsätze abbuchen & Joker verbrauchen
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
    if (state.phase !== 'CATEGORY') return;
    if (isCurrentRoundResolved()) return;
    const basePayout = Math.floor(state.categoryPot / ROUNDS_PER_CATEGORY);
    const totalPot = basePayout + state.carryRound;

    const arrayIds = Array.isArray(winnerIds) ? winnerIds : [];
    const uniqueIds = [...new Set(arrayIds.filter(id => id !== null && id !== undefined).map(id => String(id)))].filter(id => teams.has(id));

    let resolved = false;
    let finalWinnerId = null;
    const distributed = [];

    if (uniqueIds.length > 1) {
      const share = Math.floor(totalPot / uniqueIds.length);
      const remainder = totalPot % uniqueIds.length;
      uniqueIds.forEach((id, idx) => {
        const team = teams.get(id);
        if (!team) return;
        const gain = share + (idx < remainder ? 1 : 0);
        team.coins += gain;
        state.roundWins[id] = (state.roundWins[id] || 0) + 1;
        state.categoryEarnings[id] = (state.categoryEarnings[id] || 0) + gain;
        distributed.push({ id, gain });
      });
      state.carryRound = 0;
      resolved = uniqueIds.length > 0;
    } else {
      const candidate = uniqueIds.length === 1 ? uniqueIds[0] : (winnerId !== null && winnerId !== undefined ? String(winnerId) : null);
      if (candidate && teams.has(candidate)) {
        const team = teams.get(candidate);
        const gain = totalPot;
        team.coins += gain;
        state.carryRound = 0;
        state.roundWins[candidate] = (state.roundWins[candidate] || 0) + 1;
        state.categoryEarnings[candidate] = (state.categoryEarnings[candidate] || 0) + gain;
        distributed.push({ id: candidate, gain });
        finalWinnerId = candidate;
        resolved = true;
      } else if (winnerId === null) {
        state.carryRound += basePayout;
        resolved = true;
      }
    }

    if (!resolved) return;

    setCurrentRoundResolved(true);
    io.emit('result:announce', {
      winnerId: finalWinnerId,
      winnerIds: uniqueIds.length > 0 ? uniqueIds : (finalWinnerId ? [finalWinnerId] : []),
      category: state.currentCategory,
      roundIndex: state.roundIndex,
      payout: basePayout,
      carry: state.carryRound,
      distributed,
    });
    emitAll(io);
    markDirty();
  },

  adminRoundNext(io){
    if(state.phase!=='CATEGORY') return;
    state.roundIndex = Math.min(ROUNDS_PER_CATEGORY-1, state.roundIndex+1);
    state.submissions = {}; // neue Runde

    // 🦌 Elch: neue Runde → Buzz zurücksetzen, Buzz freigeben, Kategorie bleibt (Admin kann neu ziehen)
    if (state.currentCategory === 'Elch') {
      state.elch.buzzOrder = [];
      state.elch.buzzLocked = false;
      // NEU: Sprache pro Runde neu ziehen lassen → aktuelle Sprache leeren (solange nicht exhausted)
      if (!state.elch.exhausted) {
        state.elch.category = null; // Admin klickt erneut "Sprache ziehen"
      }
    }

    setCurrentRoundResolved(false);
    emitState(io);
    markDirty();
  },

  adminRoundPrev(io){
    if(state.phase!=='CATEGORY') return;
    state.roundIndex = Math.max(0, state.roundIndex-1);
    state.submissions = {};
    // Elch-Buzz leeren um Verwirrung zu vermeiden & Sprache freigeben (erneut ziehen möglich)
    if (state.currentCategory === 'Elch') {
      state.elch.buzzOrder = [];
      state.elch.buzzLocked = false;
      if (!state.elch.exhausted) state.elch.category = null;
    }
    setCurrentRoundResolved(false);
    emitState(io);
    markDirty();
  },

  adminFinishCategory(io){
    // Zusammenfassung vor Reset merken
    const summary = {
      category: state.currentCategory,
      // coins gewonnen pro Team (nur Gewinne, Einsätze nicht berücksichtigt)
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

    // Elch komplett zurücksetzen
    state.elch = {
      category: null,
      used: [],
      buzzOrder: [],
      buzzLocked: false,
      exhausted: false,
    };
  // Join-Code behalten (Lobby)

    emitAll(io);
  markDirty();
  },

  // Nur zur Lobby wechseln OHNE Zusammenfassung zu senden (Abbruch)
  adminGotoLobby(io){
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
    state.elch = { category:null, used:[], buzzOrder:[], buzzLocked:false, exhausted:false };
    emitAll(io);
    markDirty();
  },

  // ===== TIMER =====
  adminTimerStart(io, { seconds }){
    const s = Math.max(1, Math.min(999, Number(seconds)||0));
    state.timerDuration = s;
    state.timerEndsAt = Date.now() + s*1000;
    state.timerPausedRemaining = 0;
    emitState(io);
    markDirty();
  },
  adminTimerStop(io){
    // compute remaining seconds and store it separately to show frozen bar
    if (state.timerEndsAt) {
      const remaining = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
      state.timerPausedRemaining = remaining;
    }
    state.timerEndsAt = null;
  // behalten, damit Resume möglich
    emitState(io);
    markDirty();
  },
  adminTimerReset(io){
    state.timerEndsAt = null;
    state.timerDuration = 0;
    state.timerPausedRemaining = 0;
    emitState(io);
    markDirty();
  },
  adminTimerResume(io){
    if (!state.timerEndsAt && state.timerPausedRemaining > 0) {
      const s = Math.max(1, Number(state.timerPausedRemaining) || 0);
      state.timerEndsAt = Date.now() + s * 1000;
      // keep timerDuration as original total to preserve bar ratio
      state.timerPausedRemaining = 0;
      emitState(io);
      markDirty();
    }
  },

  // ===== 🦌 ELCH ADMIN =====
  adminElchDraw(io){
    if (state.currentCategory !== 'Elch') return;
    const pool = ELCH_LANGS.filter(x => !state.elch.used.includes(x));
    if (pool.length === 0) {
      state.elch.exhausted = true;
      state.elch.category = null;
    } else {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      state.elch.category = pick;
      state.elch.used.push(pick);
      state.elch.exhausted = (state.elch.used.length >= ELCH_LANGS.length);
      // neue „Sprache“ → Buzz leeren & freigeben
      state.elch.buzzOrder = [];
      state.elch.buzzLocked = false;
    }
    emitState(io);
  },

  adminElchSetLock(io, { locked }){
    if (state.currentCategory !== 'Elch') return;
    state.elch.buzzLocked = !!locked;
    emitState(io);
  },

  adminElchClearBuzz(io){
    if (state.currentCategory !== 'Elch') return;
    state.elch.buzzOrder = [];
    state.elch.buzzLocked = false;
    // Wunsch: Beim Freigeben auch die zuletzt gezogene Sprache leeren, damit neu gezogen werden muss
    if (!state.elch.exhausted) {
      state.elch.category = null; // used-Liste bleibt, damit keine Wiederholung
    }
    emitState(io);
  },

  // ===== 🏁 RACE MODE (Scoreboard) =====
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
  // (statt nur Coins/Joker zurücksetzen)
  teams.clear();
    // Inform clients about the hard reset so they can re-request/join
    io.emit('server:reset');
  // Falls du stattdessen nur zurücksetzen willst, entferne die Zeile oben und nutze untenstehenden Loop
  // for(const t of teams.values()){ t.coins = 24; t.quizJoker = 1; }
    emitAll(io);
    markDirty();
  },
};

/* =============================
   Socket.IO Routing
================================*/
io.on('connection', (socket) => {
  try { console.log(`🔌 Socket connected: ${socket.id} from ${socket.handshake.address}`); } catch(e){}
  // Pull
  socket.on('requestState', () => game.sendState(io, socket));
  socket.on('requestTeams', () => game.sendTeams(io, socket));

  // Team
  socket.on('team:join', (p) => game.teamJoin(io, socket, p));
  socket.on('team:setStake', (p) => game.teamSetStake(io, socket, p));

  // Submissions
  socket.on('team:hase:submit',    (p)=> game.teamSubmit(io, socket, 'Hase', p));
  socket.on('team:kranich:submit', (p)=> game.teamSubmit(io, socket, 'Kranich', p));
  socket.on('team:robbe:submit',   (p)=> game.teamSubmit(io, socket, 'Robbe', p));
  socket.on('team:eule:submit',    (p)=> game.teamSubmit(io, socket, 'Eule', p));
  socket.on('team:wal:submit',     (p)=> game.teamSubmit(io, socket, 'Wal', p));
  socket.on('team:elch:buzz',      ()=> game.teamSubmit(io, socket, 'Elch', { buzz:true })); // nur Buzz!
  socket.on('team:elch:submit',    ()=> {/* ignoriert – Elch antwortet laut */});
  socket.on('team:baer:submit',    (p)=> game.teamSubmit(io, socket, 'Bär', p));
  socket.on('team:fuchs:submit',   (p)=> game.teamSubmit(io, socket, 'Fuchs', p));

  // Admin
  socket.on('admin:resume', () => game.adminResume(io, socket));
  socket.on('admin:team:update', (p) => game.adminTeamUpdate(io, p));
  socket.on('admin:category:start', (p) => game.adminStartCategory(io, p));
  socket.on('admin:stakes:lock', () => game.adminLockStakes(io));
  socket.on('admin:round:resolve', (p) => game.adminResolveRound(io, p));
  socket.on('admin:round:next', () => game.adminRoundNext(io));
  socket.on('admin:round:prev', () => game.adminRoundPrev(io));
  socket.on('admin:category:finish', () => game.adminFinishCategory(io));
  socket.on('admin:lobby', () => game.adminGotoLobby(io));

  // Timer
  socket.on('admin:timer:start', (p) => game.adminTimerStart(io, p));
  socket.on('admin:timer:stop',  () => game.adminTimerStop(io));
  socket.on('admin:timer:reset', () => game.adminTimerReset(io));
  socket.on('admin:timer:resume', () => game.adminTimerResume(io));

  // 🦌 Elch (Admin)
  socket.on('admin:elch:draw',      () => game.adminElchDraw(io));
  socket.on('admin:elch:setLock',   (p) => game.adminElchSetLock(io, p)); // {locked:boolean}
  socket.on('admin:elch:clearBuzz', () => game.adminElchClearBuzz(io));

  // 📊 Scoreboard V2 controls (forward Admin → all clients)
  socket.on('scoreboard:v2:run',     (p) => io.emit('scoreboard:v2:run', p));
  socket.on('scoreboard:v2:mode',    (p) => io.emit('scoreboard:v2:mode', p));
  // removed: scoreboard:v2:countup and :replay – CountUp auto-triggers after stacking; replay dropped
  socket.on('scoreboard:v2:arm',     () => io.emit('scoreboard:v2:arm'));
  socket.on('scoreboard:v2:start',   (p) => io.emit('scoreboard:v2:start', p));

  // 🏁 Race (Scoreboard)
  socket.on('admin:race:set',   (p) => game.adminRaceSet(io, p));  // {mode:'PRE'|'RACE'|'POST'}
  socket.on('admin:race:show',  () => game.adminRaceShow(io));     // alias → 'RACE'
  socket.on('admin:race:hide',  () => game.adminRaceHide(io));     // alias → 'POST'
  socket.on('admin:race:toggle',() => game.adminRaceToggle(io));   // alias toggle

  // Team-Limit setzen
  socket.on('admin:teamLimit:set', (p) => game.adminSetTeamLimit(io, p));

  // Full reset (scores & state)
  socket.on('admin:reset:all', () => game.adminResetAll(io));
});

// additional logging for disconnects
io.on('disconnect', (reason) => {
  try { console.log('🔌 Socket.IO server disconnect event', reason); } catch(e){}
});

// Timer-Tick für automatische Submits bei Ablauf
setInterval(() => {
  if (
    state.phase === 'CATEGORY' &&
    state.timerEndsAt &&
    Date.now() >= state.timerEndsAt
  ) {
    // Timer abgelaufen
    state.timerEndsAt = null;
    // Automatisch alle vorhandenen Antworten als Submission übernehmen (falls nicht schon geschehen)
    // (Hier: keine neuen Daten, sondern vorhandene submissions bleiben, aber du könntest hier z.B. "locked" setzen)
    // Optional: Du könntest hier auch ein Feld "locked: true" setzen oder ein Event schicken
    emitState(io);
  }
}, 300);

const PORT = Number(process.env.PORT) || 3001;

server.listen(PORT, () => console.log(`✅ Backend auf http://localhost:${PORT}`));

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
   Join-Code (Lobby) – Admin Events
============================= */
function genJoinCode(){
  // 6-stellig, kein führendes 0-only Muster
  let c = String(Math.floor(100000 + Math.random()*900000));
  return c;
}

io.on('connection', (socket) => {
  // Admin kann Lobby „armen“: Code erzeugen und an Screen senden
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
