// backend/src/index.js
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { loadItemsFromCSV, toSI, formatFromSI, scoreGuess, normalizePromptText, dealHand as dealHandUtil } from './cards.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

/* -------------------- App & Server -------------------- */
const app = express();
app.use(cors());
app.use(express.json());

app.get('/test', (req, res) => res.json({ ok: true, ts: Date.now() }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  // allow both websocket and polling fallback (improves compatibility behind firewalls/proxies)
  transports: ['websocket', 'polling'],
  path: '/socket.io', // muss zum Client passen
});

/* -------------------- In-Memory State -------------------- */
const rooms = new Map();           // code -> { ...room }
const sessions = new Map();        // playerId -> { roomCode, teamId, lastSeen }
const PORT = process.env.PORT || 4000;

/* -------------------- Helpers -------------------- */
function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      state: 'lobby',
      teams: new Map(),            // socketId -> player
      playersByTeamId: new Map(),  // teamId -> player
      readyPlayers: new Set(),     // socketIds marked ready
      admins: new Set(),           // socketIds
  // require at least 2 players to start by default
  minPlayers: Number(process.env.MIN_PLAYERS) || 2,
      submitted: new Map(),        // teamId -> submission
      roundIndex: 0,
      symbols: {},
      currentReferenceCard: null,
      targetExpression: null,
      lastRoundPayload: null,
      lastRevealPayload: null,
      tutorialEnabled: false,
      tutorialShown: false,
    tutorialDelay: 1500,
    // auto-start fallback (ms) if admin doesn't press start after tutorial
    tutorialAutoStartTimeout: 60000,
    // internal timer id for scheduled auto-start
    _tutorialAutoStartTimer: null,
  // track which connected sockets have acknowledged closing the tutorial
  tutorialClosedSet: new Set(),
  // flag: admin requested start but we are waiting for clients to close tutorial
  pendingStartAfterTutorial: false,
      // game settings (admin-configurable)
      rounds: 5,
      timer: 60,
      jokersEnabled: true,
      teamMode: 'solo',
      winCondition: 'rounds',
      
      teamSize: 2,
    });
  }
  return rooms.get(code);
}

const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Prepare hand objects for emission to clients: ensure lowercase `prompt`, `promptEmoji`, `unit`, `emoji` exist
function prepareHandForEmission(hand = []) {
  return (hand || []).map(c => ({
    ...c,
    // ensure frontend-friendly fields
    prompt: normalizePromptText(c.Prompt || c.prompt || ''),
    Prompt: normalizePromptText(c.Prompt || c.prompt || ''),
    promptEmoji: c.Emoji || c.emoji || '',
    unit: c.display_unit || c.unit || '',
    display_unit: c.display_unit || c.unit || '',
    emoji: c.Emoji || c.emoji || '',
  }));
}

/* -------------------- Items (CSV) -------------------- */
// loadItemsFromCSV is provided by ./cards.js

// Utilities and csv loader are provided by ./cards.js
let ITEMS = loadItemsFromCSV();

function dealHand(category, excludeIds = []) {
  return dealHandUtil(ITEMS, category, excludeIds);
}

// Ensure that a player's multipliers always include the core standard multipliers
function ensureStandardMultipliers(existing = []) {
  try {
    const defaults = getDefaultMultipliers().filter(m => m.type === 'standard');
    const byId = new Map(existing.map(m => [m.id, m]));
    // merge defaults if missing
    for (const d of defaults) {
      if (!byId.has(d.id)) {
        byId.set(d.id, { ...d });
      }
    }
    // preserve original order: standards first (in defaults order), then others
    const others = existing.filter(m => m.type !== 'standard');
    return [...defaults.map(d => byId.get(d.id)), ...others];
  } catch (e) {
    return existing;
  }
}

function calculateLogError(tip, target) {
  if (!isFinite(tip) || !isFinite(target) || tip <= 0 || target <= 0) return Infinity;
  return Math.abs(Math.log10(tip / target));
}

function getDefaultMultipliers() {
  // Standard multipliers (no duplicates): ×0.5, ×2, ×5, ×10
  // Plus rare joker/mega multipliers (divide variants included as requested)
  return [
    { id: 'm05', label: '×0.5',  factor: 0.5,    type: 'standard' },
    { id: 'm2',  label: '×2',    factor: 2,      type: 'standard' },
    { id: 'm5',  label: '×5',    factor: 5,      type: 'standard' },
    { id: 'm10', label: '×10',   factor: 10,     type: 'standard' },
    // also include divide variants as standard options
    { id: 'd5',  label: '÷5',    factor: 1/5,    type: 'standard' },
    { id: 'd10', label: '÷10',   factor: 1/10,   type: 'standard' },

    // Joker / Mega multipliers (rare). Include both multiply and divide variants.
    { id: 'j50_mul',  label: '×50',    factor: 50,       type: 'joker', used: false },
    { id: 'j50_div',  label: '÷50',    factor: 1 / 50,   type: 'joker', used: false },
    { id: 'j100_mul', label: '×100',   factor: 100,      type: 'joker', used: false },
    { id: 'j100_div', label: '÷100',   factor: 1 / 100,  type: 'joker', used: false },
    { id: 'j1000_mul',label: '×1000',  factor: 1000,     type: 'joker', used: false },
    { id: 'j1000_div',label: '÷1000',  factor: 1 / 1000, type: 'joker', used: false },
  ];
}

/* -------------------- Round Flow -------------------- */
function startRound(nsp, room, preview = null) {
  console.log(`[startRound] startRound called for room=${room.code} teams=${room.teams.size} roundIndex=${room.roundIndex + 1}`);
  try { if (room._tutorialAutoStartTimer) { clearTimeout(room._tutorialAutoStartTimer); room._tutorialAutoStartTimer = null; } } catch(e){}
  const cats = Object.keys(ITEMS).filter((k) => Array.isArray(ITEMS[k]) && ITEMS[k].length > 0);
  if (!cats.length) return;

  // allow caller to pass a preview object (selected category/base/k) so the preview shown to clients
  // stays consistent with the actual round that starts after the countdown
  let cat, base, k;
  if (preview && preview.category && preview.base && isFinite(preview.k)) {
    cat = preview.category;
    base = preview.base;
    k = preview.k;
  } else {
    cat = randomPick(cats);
    base = randomPick(ITEMS[cat]);
    k = randomPick([0.5, 2, 3, 4, 5, 10]);
  }

  room.currentReferenceCard = base;
  room.targetExpression = {
    k,
    refId: base.id,
    refPrompt: base.prompt,
    refLabel: normalizePromptText(base.prompt || ''),
    unit: base.unit,
    target: base.trueValue * k,
    category: cat,
  };
  room.state = 'playing';
  room.submitted = new Map();
  room.roundIndex++;

  // Deal hands per player, excluding the reference card to avoid duplicates/confusion
  for (const p of room.teams.values()) {
    p.hand = dealHand(cat, [base.id]);
    // ensure core standard multipliers exist
    p.multipliers = ensureStandardMultipliers(Array.isArray(p.multipliers) ? p.multipliers : getDefaultMultipliers());
  }

  // Broadcast basis
  // include a human-friendly example of the actual target, e.g. "2 m" or "42195 m"
  const example = (() => {
    try {
      const fmt = formatFromSI(base, room.targetExpression.target);
      return `${fmt.value} ${fmt.unit || ''}`.trim();
    } catch (e) { return '' }
  })();

  const roundPayload = {
    category: cat,
    k: room.targetExpression.k,
    refPrompt: room.targetExpression.refPrompt,
    refExample: example,
    roundInfo: { current: room.roundIndex, max: room.rounds || 0 }
  };
  room.lastRoundPayload = roundPayload;
  room.lastRevealPayload = null;
  nsp.to(room.code).emit('ROUND_START', roundPayload);

  // Send each player their hand & multipliers
  // helper: map some prompt keywords to emoji
  const mapPromptToEmoji = (prompt) => {
    const s = String(prompt || '').toLowerCase();
    // keyword -> emoji mapping (expandable)
    const map = {
      // animals
      delfin: '🐬', dolphin: '🐬', pferd: '🐴', horse: '🐴', giraffe: '🦒', hund: '🐶', katze: '🐱', fisch: '🐟', vogel: '🐦', wal: '🐋', elefant: '🐘', löwe: '🦁', tiger: '🐯', bär: '🐻', hase: '🐰', pinguin: '🐧', igel: '🦔', affe: '🐒', kuh: '🐄', ziege: '🐐', schaf: '🐑', huhn: '🐔', ente: '🦆', huhn: '🐔', schmetterling: '🦋', biene: '🐝', lama: '🦙', krokodil: '🐊', schildkröte: '🐢', krake: '🐙', oktopus: '🐙', dachs: '🦡', papagei: '🦜', kaninchen: '🐇', schwein: '🐖', pferd: '🐴', galopp: '🐎', pinguin: '🐧', delphin: '🐬',
      // vehicles / speed / transport
  auto: '🚗', wagen: '🚗', car: '🚗', fahrrad: '🚲', rad: '🚲', bike: '🚲', zug: '🚆', bahn: '🚆', flugzeug: '✈️', plane: '✈️', helikopter: '🚁', rakete: '🚀', uboot: '🛳️', boot: '⛵', segelboot: '⛵', schiff: '🛳️', ferry: '⛴️', lkw: '🚚', truck: '🚚', bus: '🚌', linienbus: '🚌', tram: '🚊', 'straßenbahn': '🚊', subway: '🚇', 'u-bahn': '🚇', roller: '🛵', moped: '🛵', fahrzeug: '🚗', motor: '🏍️', motorrad: '🏍️',
      // sport / running / marathon
      marathon: '🏃', laufen: '🏃', rennen: '🏃', sprint: '🏃', galopp: '🏇',
      // objects / food
      kasten: '📦', bier: '🍺', pizza: '🍕', kuchen: '🍰', kamera: '📷', ball: '⚽', gitarre: '🎸', klavier: '🎹',
      brücke: '🌉', stadion: '🏟️', bahnhof: '🚉', kirche: '⛪', dom: '⛪', kathedrale: '⛪', haus: '🏠', wohnhaus: '🏠', mehrfamilienhaus: '🏢', wolkenkratzer: '🏙️', hausboot: '🏠', leuchtturm: '🗼', laterne: '💡', straßenlaterne: '💡', laternenpfahl: '💡', bank: '🏦', theater: '🎭', museum: '🏛️', cafe: '☕', restaurant: '🍽️', park: '🌳', see: '🌊', meer: '🌊', fluss: '🌊', berg: '🏔️', tunnel: '🛣️', kreuzung: '🛣️', ampel: '🚦', tankstelle: '⛽', supermarkt: '🛒', winkel: '🏬', supermarktwagen: '🛒', supermarkt_klein: '🛍️',
      // categories
      speed: '⚡', geschwindigkeit: '⚡', kmh: '⚡', ms: '⚡', distance: '📏', entfernung: '📏', m: '📏', km: '📏', weight: '🏋️', gewicht: '🏋️', kg: '🏋️', size: '📐', größe: '📐', höhe: '📐', länge: '📐',
    };

    // try direct keyword match on words in prompt
    const tokens = s.split(/[^\p{L}0-9]+/u).filter(Boolean);
    for (const t of tokens) {
      if (map[t]) return map[t];
      // fallback: singular/plural forms (basic)
      if (t.endsWith('en') && map[t.slice(0, -2)]) return map[t.slice(0, -2)];
      if (t.endsWith('e') && map[t.slice(0, -1)]) return map[t.slice(0, -1)];
    }

    // category-based fallback
    if (s.includes('speed') || s.includes('geschwindigkeit') || s.includes('km/h') || s.includes('m/s') || s.includes('galopp') || s.includes('höchstgeschwindigkeit')) return '⚡';
    if (s.includes('distance') || s.includes('entfernung') || s.includes('m') || s.includes('km') || s.includes('reichweite')) return '�';
    if (s.includes('weight') || s.includes('gewicht') || s.includes('kg') || s.includes('tonne')) return '�️';
    if (s.includes('size') || s.includes('größe') || s.includes('höhe') || s.includes('länge') || s.includes('giraffe')) return '📐';

    // otherwise generic placeholder
    return '❓';
  };

    for (const p of room.teams.values()) {
      const handPrepared = prepareHandForEmission(p.hand);
      const handWithEmoji = handPrepared.map(c => ({ ...c, promptEmoji: c.promptEmoji || mapPromptToEmoji(c.prompt || c.Prompt || '') }));
      try {
        console.log(`[PLAYER_HAND] emit to ${p.socketId} handCount=${(handWithEmoji||[]).length} sample=${handWithEmoji && handWithEmoji.length ? JSON.stringify({ id: handWithEmoji[0].id, prompt: handWithEmoji[0].prompt, promptEmoji: handWithEmoji[0].promptEmoji }) : 'none'}`);
      } catch (e) {}
      nsp.to(p.socketId).emit('PLAYER_HAND', {
        hand: handWithEmoji,
        multipliers: p.multipliers,
      });
    }

  // Progress reset
  nsp.to(room.code).emit('SUBMISSION_UPDATE', {
    submitted: 0,
    total: room.teams.size,
  });
}

function autoReveal(nsp, room) {
  room.state = 'reveal';
  const target = room.targetExpression?.target;

  const results = [];
  for (const [teamId, s] of room.submitted) {
    const siGuess = (typeof s.siValue === 'number' && isFinite(s.siValue)) ? s.siValue : toSI(s.card || {}, s.value, s.card?.display_unit || s.card?.unit);
    const siTrue = room.targetExpression?.target;
    const diffAbs = Math.abs(siTrue - siGuess);
    const diffPct = siTrue ? Math.abs(diffAbs / siTrue) : null;
    results.push({
      teamId,
      siGuess,
      diffAbs,
      diffPct,
      // include trueValue and display/unit info so later formatting can produce a human-friendly baseValue
      card: s.card ? {
        id: s.card.id,
        Prompt: s.card.Prompt || s.card.prompt,
        prompt: s.card.Prompt || s.card.prompt,
        display_unit: s.card.display_unit || s.card.unit,
        baseUnit: s.card.baseUnit || s.card.display_unit || s.card.unit || '',
        trueValue: s.card.trueValue ?? s.card.true_value ?? s.card.value ?? undefined,
      } : undefined,
      mult: s.mult ? { id: s.mult.id, label: s.mult.label, factor: s.mult.factor, type: s.mult.type } : undefined,
    });
  }
  results.sort((a, b) => a.diffAbs - b.diffAbs);

  // format target for display using the chosen display unit (room.targetExpression.unit could be base unit)
  const formattedTarget = formatFromSI({
    Kategorie: room.targetExpression?.category,
    display_unit: room.targetExpression?.unit,
  }, room.targetExpression?.target, room.targetExpression?.unit);

  // prepare a formatted base value (the value that is multiplied by k)
  const baseCard = room.currentReferenceCard;
  const formattedBase = (baseCard ? formatFromSI(baseCard, baseCard.trueValue) : null);

  const revealPayload = {
    targetValue: formattedTarget.value,
    unit: formattedTarget.unit,
    funFact: room.currentReferenceCard?.FunFact || room.currentReferenceCard?.funFact,
    // include the reference prompt and its formatted base value + unit and multiplier k
    refPrompt: room.targetExpression?.refPrompt,
    refLabel: room.targetExpression?.refLabel,
    refBaseValue: formattedBase?.value,
    refBaseUnit: formattedBase?.unit,
    // human-readable composition string, e.g. "15 km × 4 = 60 km"
    refComposed: (formattedBase && formattedTarget) ? `${formattedBase.value} ${formattedBase.unit || ''} × ${room.targetExpression?.k} = ${formattedTarget.value} ${formattedTarget.unit || ''}`.trim() : undefined,
    k: room.targetExpression?.k,
    ranking: results.map((r, i) => {
      // prefer the submitted card for display; if missing, use reference card
      const displayCard = r.card || room.currentReferenceCard || {};
      // formatted base for the card (e.g. "15 km")
      let cardBaseFmt = null;
      try {
        if (displayCard && typeof displayCard === 'object' && isFinite(displayCard.trueValue)) {
          cardBaseFmt = formatFromSI(displayCard, displayCard.trueValue);
        }
      } catch (e) { cardBaseFmt = null; }

      // formatted guess (human readable) — prefer card's display unit when available
      const guessFormatted = (() => {
        try { return formatFromSI(displayCard, r.siGuess, (r.card && r.card.display_unit) || room.targetExpression?.unit); } catch (e) { return null; }
      })();

      return {
        teamId: r.teamId,
        teamName: room.playersByTeamId.get(r.teamId)?.name || 'Unknown',
        // human-readable guess (e.g. "60 km")
        guess: guessFormatted || null,
        // raw values for frontend if needed
        guessRaw: { value: r.value, siValue: r.siGuess },
        diffAbsSI: r.diffAbs,
        diffPct: r.diffPct,
        rank: i + 1,
        // card details so UI can show: prompt, baseValue, baseUnit
        card: displayCard ? {
          id: displayCard.id,
          Prompt: displayCard.Prompt || displayCard.prompt || displayCard.refPrompt,
          prompt: displayCard.Prompt || displayCard.prompt || displayCard.refPrompt,
          baseValue: cardBaseFmt?.value,
          baseUnit: cardBaseFmt?.unit,
          trueValue: displayCard.trueValue,
          display_unit: displayCard.display_unit || displayCard.unit,
        } : null,
        // multiplier info
        mult: r.mult || null,
      };
    }),
    roundInfo: { current: room.roundIndex, max: room.rounds || 0 }
  };
  room.lastRevealPayload = revealPayload;
  room.lastRoundPayload = null;
  nsp.to(room.code).emit('REVEAL', revealPayload);

  // Award a symbol to the round winner (first in results) if any
  if (results.length > 0) {
    const winner = results[0].teamId;
    if (!room.symbols[winner]) room.symbols[winner] = [];
    const categorySymbol = room.targetExpression?.category || 'misc';
    // symbol representation: emoji for category
    const catEmojiMap = { speed: '⚡', distance: '📏', weight: '🏋️', size: '📐' };
    const sym = catEmojiMap[categorySymbol] || '⭐';
    room.symbols[winner].push({ category: categorySymbol, symbol: sym });
    console.log(`[autoReveal] awarded symbol ${sym} (${categorySymbol}) to team=${winner}`);
    // emit updated symbols to clients
    nsp.to(room.code).emit('SYMBOLS_UPDATE', room.symbols);

    // Check win conditions: either 4 symbols of the same category or 4 distinct categories
    const counts = {};
    const teamSymbols = room.symbols[winner] || [];
    for (const s of teamSymbols) counts[s.category] = (counts[s.category] || 0) + 1;
    const maxSame = Math.max(...Object.values(counts));
    const distinct = Object.keys(counts).length;

    const hasWon = (maxSame >= 4) || (distinct >= 4);
    if (hasWon) {
      console.log(`[autoReveal] team=${winner} has won the game! maxSame=${maxSame} distinct=${distinct}`);
      nsp.to(room.code).emit('CHAMPION_ANNOUNCEMENT', { winner: room.playersByTeamId.get(winner)?.name || winner, condition: maxSame >= 4 ? `4x ${Object.keys(counts).find(k=>counts[k]===maxSame)}` : '4 verschiedene Symbole' });
      // Prepare final standings (simple: order by total symbols)
  const standings = Array.from(room.playersByTeamId.values()).map(p => ({ teamId: p.id, teamName: p.name, symbols: (room.symbols[p.id]||[]).length }));
  standings.sort((a,b)=>b.symbols-a.symbols);
      nsp.to(room.code).emit('GAME_END', { standings, gameSettings: { rounds: room.rounds || 0 } });
      // reset room state
      room.state = 'lobby';
      room.readyPlayers.clear();
      room.symbols = {}; // reset symbols for new game
      room.lastRoundPayload = null;
      room.lastRevealPayload = null;
      return;
    }
  }

  // no points system: victory is determined by symbols only

  // If win condition is 'rounds' and we've reached the configured rounds, end the game
  try {
    // Only end by rounds when the winCondition explicitly requests rounds
    if (room.winCondition === 'rounds') {
      const max = room.rounds || 0;
      if (max > 0 && room.roundIndex >= max) {
        // prepare standings
        const standings = Array.from(room.playersByTeamId.values()).map(p => ({ teamId: p.id, teamName: p.name, symbols: (room.symbols[p.id]||[]).length }));
        standings.sort((a,b)=>b.symbols-a.symbols);
        nsp.to(room.code).emit('GAME_END', { standings, gameSettings: { rounds: room.rounds || 0 } });
        room.state = 'lobby';
        room.readyPlayers.clear();
        room.symbols = {};
        room.lastRoundPayload = null;
        room.lastRevealPayload = null;
        return;
      }
    }
  } catch (e) {}

  // Do not automatically return to lobby after reveal.
  // Keep room.state === 'reveal' and let an admin trigger the next round via ADMIN_START.
}

function checkAutoStart(nsp, room) {
  const teamCount = room.teams.size;
  const readyCount = room.readyPlayers.size;
  console.log(`[checkAutoStart] room=${room.code} teamCount=${teamCount} readyCount=${readyCount} minPlayers=${room.minPlayers} state=${room.state}`);
  // Do not auto-start. Instead, mark whether enough players are ready so admin can start.
  if (room.state === 'lobby') {
    room.canStart = (readyCount >= room.minPlayers);
    try { nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch (e) {}
  }
}

/* -------------------- Socket Handlers -------------------- */
function lobbyPayload(room) {
  return {
    teamCount: room.teams.size,
    readyCount: room.readyPlayers.size,
    canStart: !!room.canStart,
    tutorialEnabled: !!room.tutorialEnabled,
    tutorialDelay: room.tutorialDelay || 1500,
    teams: [...room.teams.entries()].map(([sid, t]) => ({
      id: t.id,
      name: t.name,
      avatar: t.avatar,
      socketId: sid,
      ready: room.readyPlayers.has(sid),
    })),
    // expose current settings for UI
    settings: {
      rounds: room.rounds,
      timer: room.timer,
      jokersEnabled: !!room.jokersEnabled,
      teamMode: room.teamMode,
      winCondition: room.winCondition,
      teamSize: room.teamSize,
      tutorialDelay: room.tutorialDelay,
      tutorialAutoStartTimeout: room.tutorialAutoStartTimeout,
    }
  };
}

function registerHandlers(nsp, socket) {
  console.log('🔌 socket connected', socket.id, 'ns', nsp.name, 'transport=', socket.conn.transport.name);

  socket.on('PING', (m, cb) => cb && cb({ ok: true, echo: m }));

  socket.on('TEAM_JOIN', (payload = {}, ack) => {
    try {
      const { roomCode, name, avatar, playerId } = payload;
      if (!roomCode || !name) {
        ack && ack({ ok: false, error: 'MISSING_FIELDS' });
        socket.emit('ERROR', { message: 'roomCode and name required' });
        return;
      }
      const room = ensureRoom(roomCode);
      // Reconnect flow: if client provided a persistent playerId and we have a session
      const persistent = playerId || `P${Math.floor(Math.random() * 10000)}_${Date.now()}`;
      let teamId = persistent;

      // If reconnecting to an existing session for the same room, reattach the player
      if (playerId && sessions.has(playerId)) {
        const sess = sessions.get(playerId);
        if (sess && sess.roomCode === roomCode) {
          teamId = sess.teamId;
          // restore a lightweight player object and re-deal hand if round is running
          const player = {
            id: teamId,
            name: name,
            avatar: avatar || '🤖',
            socketId: socket.id,
            hand: [],
            multipliers: getDefaultMultipliers(),
          };

          // If a round is active, deal a fresh hand for this joining socket (exclude reference card)
          try {
            if (room.state === 'playing' && room.targetExpression && room.targetExpression.category) {
              player.hand = dealHand(room.targetExpression.category, [room.targetExpression.refId]);
              player.multipliers = ensureStandardMultipliers(Array.isArray(player.multipliers) ? player.multipliers : getDefaultMultipliers());
            }
          } catch (e) { player.hand = player.hand || []; }

          room.teams.set(socket.id, player);
          room.playersByTeamId.set(teamId, player);
          socket.join(roomCode);
          sessions.set(persistent, { roomCode, teamId, lastSeen: Date.now() });

          // clear any scheduled empty-room abort timer (players returned)
          try { if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; } } catch(e){}

          const resp = {
            ok: true,
            teamId,
            playerId: persistent,
            roomState: room.state,
            isAdmin: room.admins.has(socket.id),
            settings: {
              rounds: room.rounds,
              timer: room.timer,
              jokersEnabled: !!room.jokersEnabled,
              teamMode: room.teamMode,
              winCondition: room.winCondition,
              teamSize: room.teamSize,
            }
          };

          // send reconnect success and initial data (hand/multipliers if any)
          try { socket.emit('RECONNECT_SUCCESS', { teamId, playerId: persistent, roomState: room.state, isAdmin: room.admins.has(socket.id), playerData: { hand: prepareHandForEmission(player.hand), multipliers: player.multipliers, name: player.name, avatar: player.avatar } }); } catch(e){}
          ack && ack(resp);
          try { nsp.to(roomCode).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch(e){}
          checkAutoStart(nsp, room);
          return;
        }
      }

      // New join (no valid session found)
      teamId = persistent;

      if (room.teams.size === 0) room.admins.add(socket.id);

      const player = {
        id: teamId,
        name,
        avatar: avatar || '🤖',
        socketId: socket.id,
        hand: [],
        multipliers: getDefaultMultipliers(),
      };
      room.teams.set(socket.id, player);
      room.playersByTeamId.set(teamId, player);

      socket.join(roomCode);
      sessions.set(persistent, { roomCode, teamId, lastSeen: Date.now() });
  // Do NOT mark players as ready automatically on join.
  // Players must explicitly emit PLAYER_READY to be counted.

  console.log(`[TEAM_JOIN] room=${roomCode} teamId=${teamId} socket=${socket.id} totalTeams=${room.teams.size} readyCount=${room.readyPlayers.size}`);

      const resp = {
        ok: true,
        teamId,
        playerId: persistent,
        roomState: room.state,
        isAdmin: room.admins.has(socket.id),
        settings: {
          rounds: room.rounds,
          timer: room.timer,
          jokersEnabled: !!room.jokersEnabled,
          teamMode: room.teamMode,
          winCondition: room.winCondition,
          teamSize: room.teamSize,
        }
      };
      ack && ack(resp);
      socket.emit('TEAM_JOINED', resp);

      // clear any scheduled empty-room abort timer (new player arrived)
      try { if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; } } catch(e){}

      nsp.to(roomCode).emit('LOBBY_UPDATE', lobbyPayload(room));

      checkAutoStart(nsp, room);
    } catch (e) {
      console.error('TEAM_JOIN failed', e);
      ack && ack({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('BEAMER_JOIN', ({ roomCode } = {}, ack) => {
    try {
      const normalized = String(roomCode || '').trim().toUpperCase();
      if (!normalized) {
        ack && ack({ ok: false, error: 'MISSING_ROOM' });
        return;
      }
      const room = ensureRoom(normalized);
      socket.join(normalized);
      const resp = {
        ok: true,
        state: room.state,
        round: room.lastRoundPayload || null,
        reveal: room.lastRevealPayload || null,
      };
      // send current phase payload to this spectator so the view syncs immediately
      if (room.state === 'playing' && room.lastRoundPayload) {
        socket.emit('ROUND_START', room.lastRoundPayload);
      } else if (room.state === 'reveal' && room.lastRevealPayload) {
        socket.emit('REVEAL', room.lastRevealPayload);
      }
      ack && ack(resp);
    } catch (e) {
      console.error('BEAMER_JOIN failed', e);
      ack && ack({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // Clients should notify when they closed the tutorial modal so server can start the round
  socket.on('TUTORIAL_CLOSED', ({ roomCode } = {}) => {
    try {
      const room = ensureRoom(roomCode);
      if (!room) return;
      room.tutorialClosedSet.add(socket.id);
      console.log(`[TUTORIAL_CLOSED] room=${roomCode} socket=${socket.id} closedTutorialCount=${room.tutorialClosedSet.size}`);
      if (room.pendingStartAfterTutorial) {
        // check if all currently connected players have closed the tutorial
        const connected = [...room.teams.keys()];
        const allClosed = connected.every(sid => room.tutorialClosedSet.has(sid));
        if (allClosed) {
          // proceed to countdown/start immediately
          room.pendingStartAfterTutorial = false;
          try { if (room._tutorialAutoStartTimer) { clearTimeout(room._tutorialAutoStartTimer); room._tutorialAutoStartTimer = null; } } catch(e){}
          // pick preview and emit PRE_ROUND_CATEGORY + countdown then startRound
          const cats = Object.keys(ITEMS).filter((k) => Array.isArray(ITEMS[k]) && ITEMS[k].length > 0);
          const chosenCat = randomPick(cats);
          const chosenBase = randomPick(ITEMS[chosenCat]);
          const chosenK = randomPick([0.5,2,3,4,5,10]);
          const preview = { category: chosenCat, base: chosenBase, k: chosenK };
          try {
            const ex = (() => { try { const f = formatFromSI(chosenBase, chosenBase.trueValue * chosenK); return `${f.value} ${f.unit || ''}`.trim(); } catch (e) { return ''; } })();
            nsp.to(room.code).emit('PRE_ROUND_CATEGORY', { category: chosenCat, k: chosenK, refPrompt: chosenBase.prompt, refExample: ex });
          } catch(e){}
          try { nsp.to(room.code).emit('PRE_ROUND_COUNTDOWN', { start: 3 }); } catch(e){}
          setTimeout(() => {
            try { startRound(nsp, room, preview); room.canStart = false; try { nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch(e){} } catch (e) { console.error('startRound after tutorial closed failed', e); }
          }, 3000);
        }
      }
    } catch (e) { console.error('TUTORIAL_CLOSED handler error', e); }
  });

  socket.on('PLAYER_READY', ({ roomCode }) => {
    const room = ensureRoom(roomCode);
    room.readyPlayers.add(socket.id);
    console.log(`[PLAYER_READY] room=${roomCode} socket=${socket.id} readyCount=${room.readyPlayers.size} totalTeams=${room.teams.size}`);
    try {
      room.canStart = (room.readyPlayers.size >= room.minPlayers);
      nsp.to(roomCode).emit('LOBBY_UPDATE', lobbyPayload(room));
    } catch (e) {}
    checkAutoStart(nsp, room);
  });

  socket.on('PLAYER_UNREADY', ({ roomCode }) => {
    const room = ensureRoom(roomCode);
    room.readyPlayers.delete(socket.id);
    console.log(`[PLAYER_UNREADY] room=${roomCode} socket=${socket.id} readyCount=${room.readyPlayers.size} totalTeams=${room.teams.size}`);
      // recompute canStart and broadcast lobby state
      try {
        room.canStart = (room.readyPlayers.size >= room.minPlayers);
        nsp.to(roomCode).emit('LOBBY_UPDATE', lobbyPayload(room));
      } catch (e) {}
  });

  // Admin can force-start a round
  socket.on('ADMIN_START', ({ roomCode } = {}, ack) => {
    try {
      const room = ensureRoom(roomCode);
      // helper to log acks for diagnostics
      const sendAdminAck = (obj) => {
        try { console.log('[ADMIN_START] sending ack:', obj); } catch (e) {}
        ack && ack(obj);
      };
      if (!room) return sendAdminAck({ ok: false, error: 'NO_ROOM' });
      if (!room.admins.has(socket.id)) return sendAdminAck({ ok: false, error: 'NOT_ADMIN' });
      // clearer handling depending on current room state
      console.log(`[ADMIN_START] admin ${socket.id} requested start for room=${roomCode} currentState=${room.state}`);
      if (room.state === 'playing') {
        return sendAdminAck({ ok: false, error: 'ALREADY_PLAYING', message: 'Eine Runde läuft bereits.' });
      }

      // require minimum ready players before admin can start
      const readyCount = room.readyPlayers.size;
      if (readyCount < room.minPlayers && room.state === 'lobby') {
        return sendAdminAck({ ok: false, error: 'NOT_ENOUGH_READY', message: `Mindestens ${room.minPlayers} Spieler müssen bereit sein.` });
      }

      // Allow admin to start next round if currently in reveal (fast-forward)
      if (room.state === 'reveal') {
        console.log(`[ADMIN_START] fast-forwarding reveal -> starting next round for room=${roomCode}`);
        // clear reveal state and start next round
        room.state = 'lobby';
        room.readyPlayers.clear();
        // treat like normal start below
      }

      // If we were paused after showing the tutorial, a subsequent ADMIN_START should trigger the first round
      if (room.waitingForAdminAfterTutorial) {
        console.log(`[ADMIN_START] received second start after tutorial for room=${roomCode}, waiting for clients to close tutorial before starting.`);
        // mark that admin requested start; the round will begin after clients signal TUTORIAL_CLOSED or on auto-start timeout
        room.pendingStartAfterTutorial = true;
        room.waitingForAdminAfterTutorial = false; // stop the older flag
        // reset recorded closes (clients will re-emit TUTORIAL_CLOSED when they close the UI)
        room.tutorialClosedSet = new Set();
        try { if (room._tutorialAutoStartTimer) { clearTimeout(room._tutorialAutoStartTimer); room._tutorialAutoStartTimer = null; } } catch(e){}
        // reply ack to admin; actual start occurs when all clients have closed the tutorial or auto-start triggers
        return sendAdminAck({ ok: true, message: 'Waiting for clients to close tutorial...' });
      }

      // If tutorial is enabled and hasn't been shown, and this is the very first round, emit TUTORIAL and mark shown
      if (room.tutorialEnabled && !room.tutorialShown && room.roundIndex === 0) {
        console.log(`[ADMIN_START] emitting full TUTORIAL for first-round in room=${roomCode} (waiting for admin start)`);
        // send a flag so clients open the full tutorial modal (not the quick notice)
          nsp.to(roomCode).emit('TUTORIAL', { full: true, message: 'Tutorial: bitte lesen. Admin muss erneut Start drücken.' , delay: room.tutorialDelay || 1500 });
          room.tutorialShown = true;
          // reset tutorial-closed tracking and indicate we're waiting for clients to close tutorial
          room.tutorialClosedSet = new Set();
          room.pendingStartAfterTutorial = true;
          // also set waitingForAdminAfterTutorial for compatibility with older logic
          room.waitingForAdminAfterTutorial = true;
        // schedule an auto-start fallback after configured timeout (if set)
        try {
          if (room._tutorialAutoStartTimer) {
            clearTimeout(room._tutorialAutoStartTimer);
            room._tutorialAutoStartTimer = null;
          }
          const to = Number(room.tutorialAutoStartTimeout) || 60000;
          room._tutorialAutoStartTimer = setTimeout(() => {
            try {
              if (room.waitingForAdminAfterTutorial || room.pendingStartAfterTutorial) {
                console.log(`[AUTO_START] tutorial timeout reached for room=${roomCode}, proceeding to start`);
                room.waitingForAdminAfterTutorial = false;
                room.pendingStartAfterTutorial = false;
                // pick preview and start immediately (emit preview + countdown for clients)
                const cats2 = Object.keys(ITEMS).filter((k) => Array.isArray(ITEMS[k]) && ITEMS[k].length > 0);
                const chosenCat2 = randomPick(cats2);
                const chosenBase2 = randomPick(ITEMS[chosenCat2]);
                const chosenK2 = randomPick([0.5, 2, 3, 4, 5, 10]);
                const preview2 = { category: chosenCat2, base: chosenBase2, k: chosenK2 };
                try {
                  const ex2 = (() => { try { const f = formatFromSI(chosenBase2, chosenBase2.trueValue * chosenK2); return `${f.value} ${f.unit || ''}`.trim(); } catch (e) { return ''; } })();
                  nsp.to(room.code).emit('PRE_ROUND_CATEGORY', { category: chosenCat2, k: chosenK2, refPrompt: chosenBase2.prompt, refExample: ex2 });
                } catch (e) {}
                try { nsp.to(room.code).emit('PRE_ROUND_COUNTDOWN', { start: 3 }); } catch (e) {}
                setTimeout(() => {
                  try {
                    startRound(nsp, room, preview2);
                    room.canStart = false;
                    try { nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch (e) {}
                  } catch (e) { console.error('AUTO_START startRound failed', e); }
                }, 3000);
              }
            } catch (e) { console.error('AUTO_START failed', e); }
            room._tutorialAutoStartTimer = null;
          }, Math.max(1000, to));
        } catch (e) {}
        // do not auto-start here; admin can also start earlier by pressing Start
      } else {
        // start immediately
        startRound(nsp, room);
      }
      // clear canStart flag after explicit admin start
      room.canStart = false;
      try { nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch (e) {}
      sendAdminAck({ ok: true });
    } catch (e) {
      console.error('ADMIN_START failed', e);
      ack && ack({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('ADMIN_TOGGLE_TUTORIAL', ({ roomCode, enabled } = {}, ack) => {
    try {
      const room = ensureRoom(roomCode);
      if (!room) return ack && ack({ ok: false, error: 'NO_ROOM' });
      if (!room.admins.has(socket.id)) return ack && ack({ ok: false, error: 'NOT_ADMIN' });
      room.tutorialEnabled = !!enabled;
      room.tutorialShown = false;
      nsp.to(roomCode).emit('LOBBY_UPDATE', lobbyPayload(room));
      ack && ack({ ok: true });
      console.log(`[ADMIN_TOGGLE_TUTORIAL] room=${roomCode} enabled=${room.tutorialEnabled}`);
    } catch (e) {
      ack && ack({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('NEW_GAME', ({ roomCode } = {}) => {
    try {
      const room = ensureRoom(roomCode);
      if (!room) return;
      // only admin may trigger NEW_GAME to reset server-side state
      if (!room.admins.has(socket.id)) return;
      console.log(`[NEW_GAME] admin ${socket.id} resetting game in room=${roomCode}`);
      room.state = 'lobby';
      room.roundIndex = 0;
      room.symbols = {};
      room.readyPlayers.clear();
      room.tutorialShown = false;
      room.waitingForAdminAfterTutorial = false;
      room.lastRoundPayload = null;
      room.lastRevealPayload = null;
      try { if (room._tutorialAutoStartTimer) { clearTimeout(room._tutorialAutoStartTimer); room._tutorialAutoStartTimer = null; } } catch(e){}
      nsp.to(room.code).emit('GAME_RESET');
      try { nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch(e){}
    } catch (e) { console.error('NEW_GAME failed', e); }
  });

  // Admin can update game settings
  socket.on('UPDATE_SETTINGS', ({ roomCode, settings } = {}, ack) => {
    try {
      const room = ensureRoom(roomCode);
      if (!room) return ack && ack({ ok: false, error: 'NO_ROOM' });
      if (!room.admins.has(socket.id)) return ack && ack({ ok: false, error: 'NOT_ADMIN' });

      // Merge allowed settings only
  const allowed = ['rounds','timer','jokersEnabled','teamMode','winCondition','teamSize'];
      for (const k of Object.keys(settings || {})) {
        if (allowed.includes(k) || k === 'tutorialDelay' || k === 'tutorialAutoStartTimeout') {
          room[k] = settings[k];
        }
      }

      // If jokers disabled, mark all joker multipliers as used to prevent selection
      if (!room.jokersEnabled) {
        for (const p of room.teams.values()) {
            if (Array.isArray(p.multipliers)) {
            p.multipliers = p.multipliers.map(m => ({ ...m, used: m.type === 'joker' ? true : (m.used || false) }));
            // push updated multipliers to player
            try { nsp.to(p.socketId).emit('PLAYER_HAND', { hand: prepareHandForEmission(p.hand), multipliers: p.multipliers }); } catch(e){}
          }
        }
      }

      // broadcast settings
      nsp.to(room.code).emit('SETTINGS_UPDATED', {
        rounds: room.rounds,
        timer: room.timer,
        jokersEnabled: !!room.jokersEnabled,
        teamMode: room.teamMode,
        winCondition: room.winCondition,
        teamSize: room.teamSize,
      });
      nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room));
      ack && ack({ ok: true });
      console.log(`[UPDATE_SETTINGS] room=${roomCode} updated settings by admin=${socket.id}`);
    } catch (e) {
      console.error('UPDATE_SETTINGS failed', e);
      ack && ack({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('SUBMIT', ({ roomCode, teamId, cardId, multiplierId, value } = {}, ack) => {
    const room = ensureRoom(roomCode);
    if (!room) return ack && ack({ ok: false, error: 'NO_ROOM' });

  // Use provided numeric value or compute from card/mult
  let numeric = (typeof value === 'number' && isFinite(value)) ? value : NaN;
  // guessUnit can be provided by client to indicate unit of numeric guess
  const guessUnit = (typeof value === 'object' && value !== null && value.unit) ? value.unit : undefined;

    let card = null;
    let mult = null;

    const player = room.playersByTeamId.get(teamId);
    if (!isFinite(numeric)) {
      card = player?.hand?.find(c => c.id === cardId) || null;
      mult = player?.multipliers?.find(m => m.id === multiplierId) || null;
      const factor = mult?.factor ?? 1;
      if (card && isFinite(card.trueValue) && isFinite(factor)) {
        numeric = card.trueValue * factor;
      }
    } else {
      // numeric provided: still try to fill card/mult for UI if IDs exist
      card = player?.hand?.find(c => c.id === cardId) || null;
      mult = player?.multipliers?.find(m => m.id === multiplierId) || null;
    }

    // If a joker was selected, ensure player hasn't exceeded joker usage limit (2 per player per game)
    try {
      if (mult && mult.type === 'joker') {
        const playerObj = room.playersByTeamId.get(teamId);
        const usedCount = (playerObj && Array.isArray(playerObj.multipliers)) ? playerObj.multipliers.filter(m => m.type === 'joker' && m.used).length : 0;
        if (usedCount >= 2) {
          ack && ack({ ok: false, error: 'JOKER_LIMIT', message: 'Joker-Limit erreicht (2 pro Spiel)'});
          return;
        }
      }
    } catch (e) {}

    if (!isFinite(numeric)) {
      ack && ack({ ok: false, error: 'BAD_SUBMISSION' });
      return;
    }

    // Normalize submission into SI units for scoring. If client provided a unit with numeric guess, use it.
    let siValue = numeric;
    try {
      if (typeof value === 'object' && value !== null && value.amount != null && value.unit) {
        // structured guess { amount: number, unit: 'km' }
        siValue = toSI(card || {}, Number(value.amount), value.unit);
      } else if (guessUnit) {
        siValue = toSI(card || {}, Number(numeric), guessUnit);
      } else if (card && card.display_unit) {
        // assume numeric is in the card's display unit
        siValue = toSI(card, Number(numeric), card.display_unit);
      } else if (card && card.unit) {
        siValue = toSI(card, Number(numeric), card.unit);
      } else {
        // fallback: treat numeric as already SI
        siValue = Number(numeric);
      }
    } catch (e) { siValue = Number(numeric); }

    // If card is missing (e.g. player submitted a raw numeric value without selecting a card)
    // create a small display-only card object so the frontend can always show a card-like entry.
    if (!card) {
      try {
        const displayUnit = guessUnit || (card && (card.display_unit || card.unit)) || '';
        card = {
          id: `manual_${teamId}`,
          Prompt: 'Freie Eingabe',
          prompt: 'Freie Eingabe',
          promptEmoji: '',
          // baseValue is the numeric value provided by the player (in the unit they submitted or SI fallback)
          baseValue: Number.isFinite(numeric) ? numeric : null,
          display_unit: displayUnit,
          unit: displayUnit,
          trueValue: Number.isFinite(numeric) ? Number(numeric) : undefined,
        };
      } catch (e) { /* ignore */ }
    }

    room.submitted.set(teamId, {
      teamId,
      value: numeric,
      siValue,
      socketId: socket.id,
      card,
      mult,
    });

    // If a joker/mega multiplier was used, mark it as used for that player so it can't be reused
    try {
      if (mult && mult.type === 'joker') {
        const playerObj = room.playersByTeamId.get(teamId);
        if (playerObj && Array.isArray(playerObj.multipliers)) {
          const idx = playerObj.multipliers.findIndex(m => m.id === mult.id);
            if (idx !== -1) {
            playerObj.multipliers[idx].used = true;
            // update player's multipliers for future PLAYER_HAND emissions
            try {
              if (playerObj.socketId) {
                nsp.to(playerObj.socketId).emit('PLAYER_HAND', { hand: prepareHandForEmission(playerObj.hand), multipliers: playerObj.multipliers });
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}

    // Fortschritt an alle
    nsp.to(room.code).emit('SUBMISSION_UPDATE', {
      submitted: room.submitted.size,
      total: room.teams.size,
    });

    ack && ack({ ok: true });

    if (room.submitted.size === room.teams.size && room.state === 'playing') {
      setTimeout(() => {
        if (room.state === 'playing') autoReveal(nsp, room);
      }, 500);
    }
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (room.teams.has(socket.id)) {
        const p = room.teams.get(socket.id);
        room.teams.delete(socket.id);
        room.playersByTeamId.delete(p.id);
        room.readyPlayers.delete(socket.id);
        room.admins.delete(socket.id);
        try { if (room.tutorialClosedSet && room.tutorialClosedSet.has(socket.id)) room.tutorialClosedSet.delete(socket.id); } catch(e){}
        console.log(`[disconnect] socket=${socket.id} removed from room=${room.code} remainingTeams=${room.teams.size}`);
        try {
          nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room));
        } catch {}
        // If the room is now empty and a round is playing, schedule an abort after 5 minutes
        try {
          if ((room.teams.size === 0) && room.state === 'playing') {
            console.log(`[disconnect] room=${room.code} is empty while playing — scheduling abort in 5 minutes`);
            try { if (room._emptyTimer) clearTimeout(room._emptyTimer); } catch(e){}
            room._emptyTimer = setTimeout(() => {
              try {
                // If still empty and still playing, reset the room
                if ((room.teams.size === 0) && room.state === 'playing') {
                  console.log(`[empty-abort] aborting round for room=${room.code} after 5min idle`);
                  room.state = 'lobby';
                  room.submitted = new Map();
                  room.readyPlayers.clear();
                  room.currentReferenceCard = null;
                  room.targetExpression = null;
                  room.lastRoundPayload = null;
                  room.lastRevealPayload = null;
                  // notify any watchers
                  try { nsp.to(room.code).emit('ROUND_END'); } catch(e){}
                  try { nsp.to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch(e){}
                }
              } catch (e) { console.error('empty-abort handler failed', e); }
              room._emptyTimer = null;
            }, 5 * 60 * 1000);
          }
        } catch (e) { console.error('disconnect empty-timer failed', e); }
      }
    }
  });
}

/* -------------------- Namespace /game -------------------- */
const gameNs = io.of('/game');
gameNs.on('connection', (s) => registerHandlers(gameNs, s));

/* -------------------- Admin/Debug Routes -------------------- */
app.get('/admin/rooms', (req, res) => {
  const roomsData = Array.from(rooms.entries()).map(([code, room]) => ({
    code,
    state: room.state,
    players: room.teams.size,
    round: room.roundIndex,
  }));
  res.json(roomsData);
});

app.get('/debug/rooms', (req, res) => {
  try {
    const data = Array.from(rooms.entries()).map(([code, room]) => ({
      code,
      state: room.state,
      teams: [...room.teams.values()].map((t) => ({
        id: t.id,
        name: t.name,
        avatar: t.avatar,
        socketId: t.socketId,
      })),
    }));
    res.json({ ok: true, rooms: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/debug/room/:code', (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (!rooms.has(code)) return res.status(404).json({ ok: false, error: 'NO_ROOM' });
    const room = rooms.get(code);
    // shallow-clone for safety
    const data = {
      code: room.code,
      state: room.state,
      roundIndex: room.roundIndex,
      teamCount: room.teams.size,
      readyCount: room.readyPlayers.size,
      teams: [...room.teams.values()].map(t => ({ id: t.id, name: t.name, avatar: t.avatar, socketId: t.socketId, hand: t.hand, multipliers: t.multipliers })),
      targetExpression: room.targetExpression,
      symbols: room.symbols,
    };
    res.json({ ok: true, room: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Admin: abort a running round immediately
app.post('/admin/room/:code/abort', (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (!rooms.has(code)) return res.status(404).json({ ok: false, error: 'NO_ROOM' });
    const room = rooms.get(code);
    if (room.state !== 'playing') return res.json({ ok: false, message: 'no active round' });
    // reset round state
    room.state = 'lobby';
    room.submitted = new Map();
    room.currentReferenceCard = null;
    room.targetExpression = null;
    room.lastRoundPayload = null;
    room.lastRevealPayload = null;
    room.readyPlayers.clear();
    try { if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; } } catch(e){}
    try { if (room._tutorialAutoStartTimer) { clearTimeout(room._tutorialAutoStartTimer); room._tutorialAutoStartTimer = null; } } catch(e){}
    try { io.of('/game').to(room.code).emit('ROUND_END'); } catch(e){}
    try { io.of('/game').to(room.code).emit('LOBBY_UPDATE', lobbyPayload(room)); } catch(e){}
    return res.json({ ok: true, message: 'aborted' });
  } catch (e) {
    console.error('ADMIN/ABORT failed', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Debug: return prepared hand for a given room and teamId (teamId is the persistent player id)
app.get('/debug/hand/:room/:teamId', (req, res) => {
  try {
    const roomCode = String(req.params.room || '').toUpperCase();
    const teamId = String(req.params.teamId || '');
    if (!rooms.has(roomCode)) return res.status(404).json({ ok: false, error: 'NO_ROOM' });
    const room = rooms.get(roomCode);
    const player = room.playersByTeamId.get(teamId);
    if (!player) return res.status(404).json({ ok: false, error: 'NO_PLAYER' });
    return res.json({ ok: true, hand: prepareHandForEmission(player.hand || []), multipliers: player.multipliers || [] });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Debug: list loaded items counts and sample entries
app.get('/debug/items', (req, res) => {
  try {
    const counts = {};
    const samples = {};
    for (const k of Object.keys(ITEMS)) {
      counts[k] = Array.isArray(ITEMS[k]) ? ITEMS[k].length : 0;
      samples[k] = (Array.isArray(ITEMS[k]) && ITEMS[k].length) ? ITEMS[k].slice(0,3).map(i => ({ id: i.id, prompt: i.prompt, value_si: i.value_si || i.trueValue, display_unit: i.display_unit || i.unit })) : [];
    }
    res.json({ ok: true, counts, samples });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Basic health endpoint for readiness/liveness checks
app.get('/health', (req, res) => {
  try {
    res.json({ ok: true, ts: Date.now(), pid: process.pid });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* -------------------- Process Diagnostics -------------------- */
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

/* -------------------- Start Server -------------------- */
// Start server with retry on EADDRINUSE (try next port up to a limit)
function startServerWithRetry(port, maxAttempts = 10) {
  let attempts = 0;

  const tryListen = (p) => {
    attempts++;
    // attach a one-time error listener for EADDRINUSE
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.warn(`Port ${p} is already in use. Attempting port ${p + 1}...`);
        if (attempts < maxAttempts) {
          // try next port
          tryListen(p + 1);
        } else {
          console.error(`Unable to bind server after ${attempts} attempts. Exiting.`);
          process.exit(1);
        }
      } else {
        console.error('Server error on listen:', err);
        process.exit(1);
      }
    };

    httpServer.once('error', onError);
    httpServer.listen(p, '0.0.0.0', () => {
      // successfully listening — remove the error listener and report
      httpServer.removeListener('error', onError);
      console.log(`🚀 Server running on http://0.0.0.0:${p}`);
    });
  };

  tryListen(port);
}

startServerWithRetry(PORT);

// Graceful shutdown helper
async function shutdown(reason) {
  try {
    console.log('Shutting down server...', reason || 'SIGTERM');
    // stop accepting new connections
    try { httpServer.close(); } catch (e) {}
    try { await io.close(); } catch (e) {}
    // close any timers in rooms
    for (const room of rooms.values()) {
      try { if (room._emptyTimer) clearTimeout(room._emptyTimer); } catch (e) {}
      try { if (room._tutorialAutoStartTimer) clearTimeout(room._tutorialAutoStartTimer); } catch (e) {}
    }
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (e) {
    console.error('Error during shutdown', e);
    process.exit(1);
  }
}

// Expose a stop function for tests or programmatic control
export { shutdown as stopServer };

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
