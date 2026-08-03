// server.js — 넘버 블러프 게임 서버
// Express + Socket.IO + Upstash Redis(REST)

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let Redis = null;
try {
  Redis = require('@upstash/redis').Redis;
} catch (e) {
  console.warn('[redis] @upstash/redis 모듈을 불러오지 못했습니다. Redis 없이 메모리로만 동작합니다.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ---------- Redis 설정 ----------
const REDIS_TTL_SECONDS = 60 * 60 * 2; // 2시간
let redis = null;
let redisEnabled = false;
if (Redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  redisEnabled = true;
  console.log('[redis] Upstash Redis 연결 설정 완료');
} else {
  console.warn('[redis] 환경변수가 없어 Redis 없이 메모리 상태로만 동작합니다. (로컬 테스트용)');
}

function roomKeys(code) {
  return {
    meta: `room:${code}:meta`,
    players: `room:${code}:players`,
    state: `room:${code}:state`,
    scores: `room:${code}:scores`,
    history: `room:${code}:roundHistory`,
  };
}

async function saveRoomToRedis(room) {
  if (!redisEnabled || !room) return;
  const k = roomKeys(room.code);
  try {
    await Promise.all([
      redis.set(k.meta, {
        code: room.code,
        hostId: room.hostId,
        phase: room.phase,
        round: room.round,
        maxRounds: room.maxRounds,
        createdAt: room.createdAt,
      }, { ex: REDIS_TTL_SECONDS }),
      redis.set(k.players, room.players, { ex: REDIS_TTL_SECONDS }),
      redis.set(k.state, {
        currentRound: room.currentRound,
        usedTokens: room.usedTokens,
      }, { ex: REDIS_TTL_SECONDS }),
      redis.set(k.scores, room.scores, { ex: REDIS_TTL_SECONDS }),
      redis.set(k.history, room.history, { ex: REDIS_TTL_SECONDS }),
    ]);
  } catch (e) {
    console.error('[redis] 저장 실패:', e.message);
  }
}

async function loadRoomFromRedis(code) {
  if (!redisEnabled) return null;
  const k = roomKeys(code);
  try {
    const [meta, players, state, scores, history] = await Promise.all([
      redis.get(k.meta),
      redis.get(k.players),
      redis.get(k.state),
      redis.get(k.scores),
      redis.get(k.history),
    ]);
    if (!meta) return null;
    const room = {
      code: meta.code,
      hostId: meta.hostId,
      phase: meta.phase,
      round: meta.round,
      maxRounds: meta.maxRounds,
      createdAt: meta.createdAt,
      players: players || [],
      currentRound: (state && state.currentRound) || emptyRound(),
      usedTokens: (state && state.usedTokens) || {},
      scores: scores || {},
      history: history || [],
      timer: null,
      pendingRPS: null,
    };
    // 재시작 후 복구된 방이므로 모든 플레이어는 재접속 전까지 연결 끊김으로 처리
    room.players.forEach((p) => { p.connected = false; p.socketId = null; });
    return room;
  } catch (e) {
    console.error('[redis] 불러오기 실패:', e.message);
    return null;
  }
}

async function deleteRoomFromRedis(code) {
  if (!redisEnabled) return;
  const k = roomKeys(code);
  try {
    await Promise.all(Object.values(k).map((key) => redis.del(key)));
  } catch (e) {
    console.error('[redis] 삭제 실패:', e.message);
  }
}

// ---------- 인메모리 방 상태 ----------
const rooms = new Map(); // code -> room
const socketIndex = new Map(); // socket.id -> { code, playerId }

function emptyRound() {
  return { tokens: {}, guesses: {}, sum: null, hints: null };
}

function makeRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function createRoom(hostNickname, hostSocketId) {
  const code = makeRoomCode();
  const hostId = crypto.randomUUID();
  const room = {
    code,
    hostId,
    phase: 'lobby', // lobby | submitting_tokens | guessing | tiebreak | reveal | game_over
    round: 0,
    maxRounds: 5,
    createdAt: Date.now(),
    players: [{ id: hostId, nickname: hostNickname, connected: true, socketId: hostSocketId }],
    currentRound: emptyRound(),
    usedTokens: { [hostId]: [] },
    scores: { [hostId]: 0 },
    history: [],
    timer: null,
    pendingRPS: null,
  };
  rooms.set(code, room);
  return room;
}

function publicPlayers(room) {
  return room.players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    connected: p.connected,
    isHost: p.id === room.hostId,
    score: room.scores[p.id] || 0,
    tokensLeft: 5 - ((room.usedTokens[p.id] || []).length),
  }));
}

function lobbySnapshot(room) {
  return {
    roomCode: room.code,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    maxRounds: room.maxRounds,
    players: publicPlayers(room),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby_update', lobbySnapshot(room));
}

function emitError(socket, message) {
  socket.emit('error_message', { message });
}

function getRoomBySocket(socket) {
  const idx = socketIndex.get(socket.id);
  if (!idx) return null;
  return rooms.get(idx.code) || null;
}

function getPlayerIdBySocket(socket) {
  const idx = socketIndex.get(socket.id);
  return idx ? idx.playerId : null;
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function sumRange(playerCount) {
  return { min: playerCount * 1, max: playerCount * 5 };
}

// ---------- 힌트 생성 ----------
function buildHint(category, sum, wantTrue) {
  switch (category) {
    case 'above': {
      const offset = 2 + Math.floor(Math.random() * 3); // 2~4
      const threshold = wantTrue ? sum - offset : sum + offset;
      return { text: `합은 ${threshold} 이상이다.`, isTrue: sum >= threshold };
    }
    case 'below': {
      const offset = 2 + Math.floor(Math.random() * 3);
      const threshold = wantTrue ? sum + offset : Math.max(1, sum - offset);
      return { text: `합은 ${threshold} 이하이다.`, isTrue: sum <= threshold };
    }
    case 'parity': {
      const isEven = sum % 2 === 0;
      const label = wantTrue ? (isEven ? '짝수' : '홀수') : (isEven ? '홀수' : '짝수');
      return { text: `합은 ${label}이다.`, isTrue: (label === '짝수') === isEven };
    }
    case 'multiple': {
      const candidates = [2, 3, 5];
      let m;
      if (wantTrue) {
        m = candidates.find((c) => sum % c === 0);
        if (m === undefined) return buildHint('above', sum, true); // 대체
      } else {
        m = candidates.find((c) => sum % c !== 0);
        if (m === undefined) return buildHint('below', sum, false);
      }
      return { text: `합은 ${m}의 배수이다.`, isTrue: sum % m === 0 };
    }
    default:
      return { text: `합은 ${sum}과 관련이 있다.`, isTrue: true };
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateHints(sum) {
  const categories = shuffle(['above', 'below', 'parity', 'multiple']).slice(0, 3);
  const falseIndex = Math.floor(Math.random() * 3);
  const hints = categories.map((cat, i) => buildHint(cat, sum, i !== falseIndex));
  return shuffle(hints);
}

// ---------- 라운드 진행 ----------
const TOKEN_DEADLINE_MS = 25000;
const GUESS_DEADLINE_MS = 20000;
const TIEBREAK_STEP_DELAY_MS = 1600;

function startRound(room) {
  room.round += 1;
  room.currentRound = emptyRound();
  room.phase = 'submitting_tokens';
  room.pendingRPS = null;
  const deadlineTs = Date.now() + TOKEN_DEADLINE_MS;
  io.to(room.code).emit('round_start', {
    round: room.round,
    maxRounds: room.maxRounds,
    deadlineTs,
    players: publicPlayers(room),
  });
  clearRoomTimer(room);
  room.timer = setTimeout(() => forceFinishTokenPhase(room), TOKEN_DEADLINE_MS);
  saveRoomToRedis(room);
}

function unusedTokensFor(room, playerId) {
  const used = room.usedTokens[playerId] || [];
  const all = [1, 2, 3, 4, 5];
  return all.filter((t) => !used.includes(t));
}

function forceFinishTokenPhase(room) {
  if (room.phase !== 'submitting_tokens') return;
  room.players.forEach((p) => {
    if (room.currentRound.tokens[p.id] === undefined) {
      const options = unusedTokensFor(room, p.id);
      const pick = options.length ? options[Math.floor(Math.random() * options.length)] : 1;
      room.currentRound.tokens[p.id] = pick;
    }
  });
  proceedToGuessPhase(room);
}

function proceedToGuessPhase(room) {
  clearRoomTimer(room);
  const sum = room.players.reduce((acc, p) => acc + room.currentRound.tokens[p.id], 0);
  room.currentRound.sum = sum;
  room.currentRound.hints = generateHints(sum);
  room.phase = 'guessing';
  const deadlineTs = Date.now() + GUESS_DEADLINE_MS;
  io.to(room.code).emit('guess_phase', {
    hints: room.currentRound.hints.map((h) => h.text),
    deadlineTs,
    submittedTokenPlayers: room.players.map((p) => p.id), // 모두 제출 완료 상태로 진입
  });
  room.timer = setTimeout(() => forceFinishGuessPhase(room), GUESS_DEADLINE_MS);
  saveRoomToRedis(room);
}

function forceFinishGuessPhase(room) {
  if (room.phase !== 'guessing') return;
  const { min, max } = sumRange(room.players.length);
  room.players.forEach((p) => {
    if (room.currentRound.guesses[p.id] === undefined) {
      room.currentRound.guesses[p.id] = min + Math.floor(Math.random() * (max - min + 1));
    }
  });
  finalizeRound(room);
}

function submittedCount(obj, players) {
  return players.filter((p) => obj[p.id] !== undefined).length;
}

// ---------- 동점 처리 (가위바위보) ----------
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

function resolveTieGroup(room, ids) {
  return new Promise((resolve) => {
    room.pendingRPS = {
      contestants: [...ids],
      choices: {},
      eliminationOrder: [],
      resolve,
    };
    io.to(room.code).emit('tiebreak_prompt', {
      contestants: room.pendingRPS.contestants,
      message: '동점자들이 가위바위보로 순위를 정합니다.',
    });
  });
}

function resolveRPSRound(room) {
  const p = room.pendingRPS;
  if (!p) return;
  const shapesPresent = new Set(Object.values(p.choices));
  io.to(room.code).emit('tiebreak_reveal', { choices: p.choices });

  if (shapesPresent.size === 1 || shapesPresent.size === 3) {
    // 무승부 -> 재대결
    setTimeout(() => {
      if (!room.pendingRPS) return;
      room.pendingRPS.choices = {};
      io.to(room.code).emit('tiebreak_redo', { contestants: room.pendingRPS.contestants });
    }, TIEBREAK_STEP_DELAY_MS);
    return;
  }

  const shapes = [...shapesPresent];
  const winnerShape = BEATS[shapes[0]] === shapes[1] ? shapes[0] : shapes[1];
  const winners = p.contestants.filter((id) => p.choices[id] === winnerShape);
  const losers = p.contestants.filter((id) => p.choices[id] !== winnerShape);

  p.eliminationOrder.push(losers);

  if (winners.length <= 1) {
    p.eliminationOrder.push(winners);
    const finalOrder = p.eliminationOrder.slice().reverse().flat();
    const resolve = p.resolve;
    room.pendingRPS = null;
    setTimeout(() => resolve(finalOrder), TIEBREAK_STEP_DELAY_MS);
    return;
  }

  setTimeout(() => {
    if (!room.pendingRPS) return;
    room.pendingRPS.contestants = winners;
    room.pendingRPS.choices = {};
    io.to(room.code).emit('tiebreak_next', { contestants: winners });
  }, TIEBREAK_STEP_DELAY_MS);
}

// ---------- 라운드 마무리 및 점수 계산 ----------
async function finalizeRound(room) {
  clearRoomTimer(room);
  room.phase = 'reveal';
  const sum = room.currentRound.sum;

  const diffs = room.players.map((p) => ({
    id: p.id,
    guess: room.currentRound.guesses[p.id],
    diff: Math.abs(room.currentRound.guesses[p.id] - sum),
  }));
  diffs.sort((a, b) => a.diff - b.diff);

  const groups = [];
  diffs.forEach((d) => {
    const last = groups[groups.length - 1];
    if (last && last[0].diff === d.diff) last.push(d);
    else groups.push([d]);
  });

  const pointsTable = [4, 3, 2, 1];
  const finalOrderIds = [];

  for (const group of groups) {
    if (group.length === 1) {
      finalOrderIds.push(group[0].id);
    } else {
      room.phase = 'tiebreak';
      io.to(room.code).emit('phase_update', {
        phase: 'tiebreak',
        message: '예측값이 같은 플레이어가 있습니다. 가위바위보로 순위를 정합니다.',
      });
      // eslint-disable-next-line no-await-in-loop
      const order = await resolveTieGroup(room, group.map((g) => g.id));
      finalOrderIds.push(...order);
      room.phase = 'reveal';
    }
  }

  const pointsAwarded = {};
  finalOrderIds.forEach((id, idx) => {
    const pts = pointsTable[idx] || 0;
    pointsAwarded[id] = pts;
    room.scores[id] = (room.scores[id] || 0) + pts;
  });

  // 사용한 토큰 기록
  room.players.forEach((p) => {
    if (!room.usedTokens[p.id]) room.usedTokens[p.id] = [];
    room.usedTokens[p.id].push(room.currentRound.tokens[p.id]);
  });

  const resultPayload = {
    round: room.round,
    sum,
    tokens: room.currentRound.tokens,
    guesses: room.currentRound.guesses,
    hints: room.currentRound.hints, // 이제 진짜/가짜 공개
    ranking: finalOrderIds.map((id, idx) => ({
      id,
      nickname: room.players.find((p) => p.id === id).nickname,
      diff: diffs.find((d) => d.id === id).diff,
      rank: idx + 1,
      points: pointsAwarded[id],
    })),
    totalScores: publicPlayers(room),
  };

  room.history.push(resultPayload);
  io.to(room.code).emit('round_result', resultPayload);
  await saveRoomToRedis(room);

  if (room.round >= room.maxRounds) {
    room.phase = 'game_over';
    const finalScores = publicPlayers(room).sort((a, b) => b.score - a.score);
    io.to(room.code).emit('game_over', {
      finalScores,
      history: room.history,
    });
    await saveRoomToRedis(room);
  } else {
    setTimeout(() => {
      if (rooms.get(room.code) === room && room.phase === 'reveal') {
        startRound(room);
      }
    }, 4500);
  }
}

// ---------- Socket.IO 이벤트 ----------
io.on('connection', (socket) => {
  socket.on('create_room', ({ nickname }) => {
    try {
      const name = (nickname || '').trim().slice(0, 12);
      if (!name) return emitError(socket, '닉네임을 입력해줘.');
      const room = createRoom(name, socket.id);
      socketIndex.set(socket.id, { code: room.code, playerId: room.hostId });
      socket.join(room.code);
      socket.emit('joined', { roomCode: room.code, playerId: room.hostId, isHost: true });
      broadcastLobby(room);
      saveRoomToRedis(room);
    } catch (e) {
      console.error(e);
      emitError(socket, '방 생성 중 오류가 발생했어.');
    }
  });

  socket.on('join_room', ({ roomCode, nickname }) => {
    try {
      const name = (nickname || '').trim().slice(0, 12);
      if (!name) return emitError(socket, '닉네임을 입력해줘.');
      const code = (roomCode || '').trim();
      const room = rooms.get(code);
      if (!room) return emitError(socket, '존재하지 않는 방번호야.');
      if (room.phase !== 'lobby') return emitError(socket, '이미 게임이 시작된 방이야.');
      if (room.players.length >= 4) return emitError(socket, '방 인원이 가득 찼어. (최대 4명)');
      if (room.players.some((p) => p.nickname === name)) {
        return emitError(socket, '이미 사용 중인 닉네임이야. 다른 닉네임을 써줘.');
      }
      const playerId = crypto.randomUUID();
      room.players.push({ id: playerId, nickname: name, connected: true, socketId: socket.id });
      room.scores[playerId] = 0;
      room.usedTokens[playerId] = [];
      socketIndex.set(socket.id, { code: room.code, playerId });
      socket.join(room.code);
      socket.emit('joined', { roomCode: room.code, playerId, isHost: false });
      broadcastLobby(room);
      saveRoomToRedis(room);
    } catch (e) {
      console.error(e);
      emitError(socket, '입장 중 오류가 발생했어.');
    }
  });

  socket.on('rejoin', async ({ roomCode, playerId }) => {
    try {
      const code = (roomCode || '').trim();
      let room = rooms.get(code);
      if (!room) {
        room = await loadRoomFromRedis(code);
        if (room) rooms.set(code, room);
      }
      if (!room) return emitError(socket, '방을 찾을 수 없어. 새로 시작해줘.');
      const player = room.players.find((p) => p.id === playerId);
      if (!player) return emitError(socket, '플레이어 정보를 찾을 수 없어. 새로 시작해줘.');

      player.connected = true;
      player.socketId = socket.id;
      room.allDisconnectedSince = null;
      socketIndex.set(socket.id, { code: room.code, playerId });
      socket.join(room.code);

      socket.emit('joined', { roomCode: room.code, playerId, isHost: room.hostId === playerId });

      // 현재 상태에 맞춰 화면 복구
      socket.emit('state_sync', {
        phase: room.phase,
        round: room.round,
        maxRounds: room.maxRounds,
        players: publicPlayers(room),
        hostId: room.hostId,
        currentHints: room.currentRound && room.currentRound.hints
          ? room.currentRound.hints.map((h) => h.text) : null,
        myTokenSubmitted: room.currentRound ? room.currentRound.tokens[playerId] !== undefined : false,
        myGuessSubmitted: room.currentRound ? room.currentRound.guesses[playerId] !== undefined : false,
        history: room.history,
      });
      broadcastLobby(room);
      saveRoomToRedis(room);
    } catch (e) {
      console.error(e);
      emitError(socket, '재접속 중 오류가 발생했어.');
    }
  });

  socket.on('start_game', () => {
    try {
      const room = getRoomBySocket(socket);
      if (!room) return emitError(socket, '방 정보를 찾을 수 없어.');
      const pid = getPlayerIdBySocket(socket);
      if (room.hostId !== pid) return emitError(socket, '호스트만 게임을 시작할 수 있어.');
      if (room.phase !== 'lobby') return emitError(socket, '이미 게임이 진행 중이야.');
      if (room.players.length < 3) return emitError(socket, '최소 3명이 모여야 시작할 수 있어.');
      startRound(room);
    } catch (e) {
      console.error(e);
      emitError(socket, '게임 시작 중 오류가 발생했어.');
    }
  });

  socket.on('submit_token', ({ token }) => {
    try {
      const room = getRoomBySocket(socket);
      if (!room) return emitError(socket, '방 정보를 찾을 수 없어.');
      const pid = getPlayerIdBySocket(socket);
      if (room.phase !== 'submitting_tokens') return emitError(socket, '지금은 토큰을 낼 시점이 아니야.');
      const t = Number(token);
      if (!Number.isInteger(t) || t < 1 || t > 5) return emitError(socket, '1~5 사이의 숫자만 낼 수 있어.');
      if ((room.usedTokens[pid] || []).includes(t)) return emitError(socket, '이미 사용한 숫자야. 다른 숫자를 내줘.');
      if (room.currentRound.tokens[pid] !== undefined) return emitError(socket, '이미 이번 라운드에 토큰을 냈어.');
      room.currentRound.tokens[pid] = t;
      io.to(room.code).emit('token_progress', {
        submitted: Object.keys(room.currentRound.tokens),
      });
      if (submittedCount(room.currentRound.tokens, room.players) === room.players.length) {
        proceedToGuessPhase(room);
      } else {
        saveRoomToRedis(room);
      }
    } catch (e) {
      console.error(e);
      emitError(socket, '토큰 제출 중 오류가 발생했어.');
    }
  });

  socket.on('submit_guess', ({ guess }) => {
    try {
      const room = getRoomBySocket(socket);
      if (!room) return emitError(socket, '방 정보를 찾을 수 없어.');
      const pid = getPlayerIdBySocket(socket);
      if (room.phase !== 'guessing') return emitError(socket, '지금은 예측값을 낼 시점이 아니야.');
      const g = Number(guess);
      const { min, max } = sumRange(room.players.length);
      if (!Number.isInteger(g) || g < min || g > max) {
        return emitError(socket, `${min}~${max} 사이의 숫자로 예측해줘.`);
      }
      if (room.currentRound.guesses[pid] !== undefined) return emitError(socket, '이미 예측값을 제출했어.');
      room.currentRound.guesses[pid] = g;
      io.to(room.code).emit('guess_progress', {
        submitted: Object.keys(room.currentRound.guesses),
      });
      if (submittedCount(room.currentRound.guesses, room.players) === room.players.length) {
        finalizeRound(room);
      } else {
        saveRoomToRedis(room);
      }
    } catch (e) {
      console.error(e);
      emitError(socket, '예측값 제출 중 오류가 발생했어.');
    }
  });

  socket.on('rps_choice', ({ choice }) => {
    try {
      const room = getRoomBySocket(socket);
      if (!room || !room.pendingRPS) return;
      const pid = getPlayerIdBySocket(socket);
      if (!room.pendingRPS.contestants.includes(pid)) return;
      if (!['rock', 'paper', 'scissors'].includes(choice)) return emitError(socket, '가위/바위/보 중 하나를 선택해줘.');
      if (room.pendingRPS.choices[pid]) return; // 이미 선택함
      room.pendingRPS.choices[pid] = choice;
      io.to(room.code).emit('tiebreak_progress', {
        chosenCount: Object.keys(room.pendingRPS.choices).length,
        total: room.pendingRPS.contestants.length,
      });
      if (Object.keys(room.pendingRPS.choices).length === room.pendingRPS.contestants.length) {
        resolveRPSRound(room);
      }
    } catch (e) {
      console.error(e);
      emitError(socket, '가위바위보 처리 중 오류가 발생했어.');
    }
  });

  socket.on('rematch', () => {
    try {
      const room = getRoomBySocket(socket);
      if (!room) return emitError(socket, '방 정보를 찾을 수 없어.');
      const pid = getPlayerIdBySocket(socket);
      if (room.hostId !== pid) return emitError(socket, '호스트만 다시하기를 시작할 수 있어.');
      if (room.phase !== 'game_over') return emitError(socket, '게임이 아직 끝나지 않았어.');
      room.round = 0;
      room.history = [];
      room.currentRound = emptyRound();
      room.pendingRPS = null;
      room.players.forEach((p) => {
        room.scores[p.id] = 0;
        room.usedTokens[p.id] = [];
      });
      room.phase = 'lobby';
      broadcastLobby(room);
      saveRoomToRedis(room);
    } catch (e) {
      console.error(e);
      emitError(socket, '다시하기 처리 중 오류가 발생했어.');
    }
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

function reassignHostIfNeeded(room) {
  const host = room.players.find((p) => p.id === room.hostId);
  if (!host || !host.connected) {
    const nextHost = room.players.find((p) => p.connected);
    if (nextHost) room.hostId = nextHost.id;
  }
}

function handleLeave(socket) {
  try {
    const idx = socketIndex.get(socket.id);
    if (!idx) return;
    socketIndex.delete(socket.id);
    const room = rooms.get(idx.code);
    if (!room) return;
    const player = room.players.find((p) => p.id === idx.playerId);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== idx.playerId);
      delete room.scores[idx.playerId];
      delete room.usedTokens[idx.playerId];
      if (room.players.length === 0) {
        rooms.delete(room.code);
        clearRoomTimer(room);
        deleteRoomFromRedis(room.code);
        return;
      }
      if (room.hostId === idx.playerId) {
        room.hostId = room.players[0].id;
      }
    } else {
      player.connected = false;
      player.socketId = null;
      reassignHostIfNeeded(room);
    }
    room.allDisconnectedSince = room.players.every((p) => !p.connected) ? Date.now() : null;
    broadcastLobby(room);
    saveRoomToRedis(room);
  } catch (e) {
    console.error(e);
  }
}

// 모두 연결이 끊긴 채 10분 이상 방치된 방은 메모리에서 정리한다.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.allDisconnectedSince && now - room.allDisconnectedSince > 10 * 60 * 1000) {
      clearRoomTimer(room);
      rooms.delete(code);
      deleteRoomFromRedis(code);
    }
  }
}, 5 * 60 * 1000);

// ---------- 정적 파일 & 라우팅 ----------
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.htm'));
});
app.get('/health', (req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`넘버 블러프 서버 실행 중: http://localhost:${PORT}`);
});
