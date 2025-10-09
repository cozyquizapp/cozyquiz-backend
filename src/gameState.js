// Duell-Version: 2 Teams, Coins, Joker, CP=Summe+JokerExtra+3, RoundPayout=CP/3

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
  fuchsHistory: {},          // teamId -> [{ guess, ts }]
  roundStartTs: null,        // Startzeit der aktuellen Runde (CATEGORY + roundIndex)

  // NEW: Timer
  timerEndsAt: null,         // ms epoch (server time)
  timerDuration: 0,          // seconds (last set)
  resolvedRounds: Object.create(null),
};

const teams = new Map();     // teamId -> { id,name,avatar,coins,quizJoker,joinedAt }

function ensureTeam(socket){ return socket.handshake.auth?.teamId || socket.id; }

function serializeState(){
  return {
    phase: state.phase,
    currentCategory: state.currentCategory,
    roundIndex: state.roundIndex,
    roundResolved: isCurrentRoundResolved(),
    stakes: state.stakes,
    categoryPot: state.categoryPot,
    carryRound: state.carryRound,
    submissions: state.submissions,
  fuchsHistory: state.fuchsHistory,
  roundStartTs: state.roundStartTs,
    timerEndsAt: state.timerEndsAt,
    timerDuration: state.timerDuration,
    serverNow: Date.now(),
  };
}
function serializeTeams(){ return Array.from(teams.values()).map(t=>({...t})); }
function currentRoundKey(){
  if (!state.currentCategory) return null;
  return state.currentCategory + ':' + state.roundIndex;
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

export const game = {
  // pull helpers
  sendState(io, socket){ socket.emit('state:update', serializeState()); },
  sendTeams(io, socket){ socket.emit('teamsUpdated', serializeTeams()); },

  // ===== TEAM FLOW =====
  teamJoin(io, socket, { name, avatar }){
    const id = ensureTeam(socket);
    if(!teams.has(id)){
      teams.set(id, {
        id,
        name: name?.trim() || `Team ${teams.size+1}`,
        avatar: avatar || 'â“',
        coins: 24,                  // Startbank
        quizJoker: 1,               // 1 Joker fÃ¼rs Quiz
        joinedAt: Date.now(),
      });
    } else {
      const t = teams.get(id);
      if(name?.trim()) t.name = name;
      if(avatar) t.avatar = avatar;
    }
    emitAll(io);
    socket.emit('team:welcome', { teamId: id });
  },

  teamSetStake(io, socket, { stake, useJoker }){
    if(state.phase !== 'STAKE') return;
    const id = ensureTeam(socket);
    const t = teams.get(id); if(!t) return;

    let s = Number(stake);
    if(!VALID_STAKES.includes(s)) s = 0;
    if(t.coins < 3 && s > 0) s = 0; // auto 0 bei Bank <3

    const allowJoker = !!useJoker && t.quizJoker > 0 && s > 0;
    state.stakes[id] = { stake: s, useJoker: allowJoker };
    emitState(io);
  },

  // submissions â€“ rohdaten anzeigen, buzz mit buzzTs
  teamSubmit(io, socket, category, payload){
    if(state.phase!=='CATEGORY' || state.currentCategory!==category) return;
    const id = ensureTeam(socket);
    const prev = state.submissions[id] || {};
    let next = { ...prev, ...payload, ts: Date.now() };
    if (payload && payload.buzz) {
      if (!prev.buzzTs) next.buzzTs = Date.now();
      next.buzz = true;
    }
    // Erst-Zeitpunkt fÃ¼r Fuchs (Speed Messung)
    if(category === 'Fuchs' && typeof payload?.guess === 'string' && !prev.firstGuessTs){
      next.firstGuessTs = Date.now();
    }
    state.submissions[id] = next;
    if(category === 'Fuchs' && typeof payload?.guess === 'string'){
      const val = payload.guess.trim();
      if(val){
        if(!state.fuchsHistory[id]) state.fuchsHistory[id] = [];
        const last = state.fuchsHistory[id][state.fuchsHistory[id].length - 1];
        if(!last || last.guess !== val){
          state.fuchsHistory[id].push({ guess: val, ts: Date.now() });
          if(state.fuchsHistory[id].length > 25){
            state.fuchsHistory[id].splice(0, state.fuchsHistory[id].length - 25);
          }
        }
      }
    }
    emitState(io);
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
  },

  adminStartCategory(io, { category }){
    state.phase = 'STAKE';
    state.currentCategory = category;
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
    state.fuchsHistory = {};
    state.roundStartTs = null; // wird bei Lock gesetzt
    state.resolvedRounds = Object.create(null);
    emitAll(io);
  },

  adminLockStakes(io){
    // Einsaetze abbuchen & Joker verbrauchen
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
    state.roundStartTs = Date.now();
    setCurrentRoundResolved(false);
    if(state.currentCategory === 'Fuchs') state.fuchsHistory = {};
    emitAll(io);
  },

  adminResolveRound(io, { winnerId, winnerIds }){
    if(state.phase!=='CATEGORY') return;
    if(isCurrentRoundResolved()) return;
    const payout = Math.floor(state.categoryPot / ROUNDS_PER_CATEGORY); // CP/3
    const chosenRaw = Array.isArray(winnerIds) ? winnerIds : [];
    const uniqueIds = [...new Set(chosenRaw.filter((id) => id !== null && id !== undefined).map((id) => String(id)))].filter((id) => teams.has(id));
    const totalPot = payout + state.carryRound;
    let resolved = false;

    if (uniqueIds.length > 1) {
      const share = uniqueIds.length ? Math.floor(totalPot / uniqueIds.length) : 0;
      const remainder = uniqueIds.length ? totalPot % uniqueIds.length : 0;
      uniqueIds.forEach((id, idx) => {
        const t = teams.get(id);
        if (!t) return;
        t.coins += share + (idx < remainder ? 1 : 0);
      });
      state.carryRound = 0;
      resolved = true;
    } else {
      const rawSingle = uniqueIds.length === 1 ? uniqueIds[0] : winnerId;
      const singleId = rawSingle !== null && rawSingle !== undefined ? String(rawSingle) : null;
      if (singleId && teams.has(singleId)) {
        const t = teams.get(singleId);
        if (t) {
          t.coins += totalPot;
          state.carryRound = 0;
          resolved = true;
        }
      } else if (winnerId === null) {
        state.carryRound += payout;
        resolved = true;
      }
    }

    if (resolved) {
      setCurrentRoundResolved(true);
      emitAll(io);
    }
  },

  adminRoundUndo(io, { snapshot }) {
    // snapshot: { coins: {teamId: number}, carryRound:number }
    if(state.phase!=='CATEGORY') return;
    if(!isCurrentRoundResolved()) return; // only if resolved
    if(!snapshot || typeof snapshot !== 'object') return;
    const { coins: coinMap, carryRound } = snapshot;
    if(coinMap && typeof coinMap === 'object'){
      for(const [tid, val] of Object.entries(coinMap)){
        if(teams.has(tid) && Number.isFinite(val)){
          teams.get(tid).coins = Math.max(0, Math.floor(val));
        }
      }
    }
    if(Number.isFinite(carryRound)){
      state.carryRound = Math.max(0, Math.floor(carryRound));
    }
    setCurrentRoundResolved(false);
    emitAll(io);
  },

  adminRoundNext(io){
    if(state.phase!=='CATEGORY') return;
    state.roundIndex = Math.min(ROUNDS_PER_CATEGORY-1, state.roundIndex+1);
    state.submissions = {}; // neue Runde
    state.fuchsHistory = {};
    state.roundStartTs = Date.now();
    setCurrentRoundResolved(false);
    emitState(io);
  },

  adminRoundPrev(io){
    if(state.phase!=='CATEGORY') return;
    state.roundIndex = Math.max(0, state.roundIndex-1);
    state.submissions = {};
    state.fuchsHistory = {};
    state.roundStartTs = Date.now();
    emitState(io);
  },

  adminFinishCategory(io){
    state.phase = 'LOBBY';
    state.currentCategory = null;
    state.roundIndex = 0;
    state.stakes = {};
    state.categoryPot = 0;
    state.carryRound = 0;
    state.submissions = {};
    state.fuchsHistory = {};
    state.roundStartTs = null;
    state.resolvedRounds = Object.create(null);
    emitAll(io);
  },

  // ===== TIMER =====
  adminTimerStart(io, { seconds }){
    const s = Math.max(1, Math.min(999, Number(seconds)||0));
    state.timerDuration = s;
    state.timerEndsAt = Date.now() + s*1000;
    emitState(io);
  },
  adminTimerStop(io){
    state.timerEndsAt = null;
    emitState(io);
  },
  adminTimerReset(io){
    state.timerEndsAt = null;
    state.timerDuration = 0;
    emitState(io);
  },
};



