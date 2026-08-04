// game.js — 넘버 블러프 클라이언트 로직
(function () {
  'use strict';

  const socket = io();

  const LS_ROOM = 'nb_roomCode';
  const LS_PLAYER = 'nb_playerId';
  const LS_NICK = 'nb_nickname';

  const state = {
    roomCode: null,
    playerId: null,
    isHost: false,
    nickname: '',
    phase: 'start', // start | lobby | game | end
    players: [],
    round: 0,
    maxRounds: 5,
    hostId: null,
    hints: [],
    myTokenSubmitted: false,
    myGuessSubmitted: false,
    tokenDoneIds: [],
    guessDoneIds: [],
    tiebreakContestants: [],
    tiebreakMyChoice: null,
    history: [],
  };

  // ---------- 유틸 ----------
  const $ = (id) => document.getElementById(id);

  function showToast(message, isError) {
    const t = $('toast');
    t.textContent = message;
    t.classList.remove('hidden');
    t.classList.toggle('error', !!isError);
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.add('hidden'), 2800);
  }

  function showScreen(name) {
    ['start', 'lobby', 'game', 'end'].forEach((s) => {
      $(`screen-${s}`).classList.toggle('hidden', s !== name);
    });
    $('header-room-badge').classList.toggle('hidden', !state.roomCode || name === 'start');
  }

  function setPanel(panelId) {
    ['panel-tokens', 'panel-guess', 'panel-tiebreak', 'panel-result'].forEach((p) => {
      $(p).classList.toggle('hidden', p !== panelId);
    });
  }

  // ---------- 로컬 저장 ----------
  function saveSession() {
    localStorage.setItem(LS_ROOM, state.roomCode || '');
    localStorage.setItem(LS_PLAYER, state.playerId || '');
    localStorage.setItem(LS_NICK, state.nickname || '');
  }
  function clearSession() {
    localStorage.removeItem(LS_ROOM);
    localStorage.removeItem(LS_PLAYER);
    localStorage.removeItem(LS_NICK);
  }

  // ---------- 렌더링: 로비 ----------
  function renderLobby() {
    $('header-room-code').textContent = state.roomCode;
    const grid = $('lobby-players');
    grid.innerHTML = '';
    state.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'player-card' + (p.isHost ? ' is-host' : '') + (p.connected ? '' : ' disconnected');
      div.innerHTML = `
        <div class="status-dot"></div>
        ${p.isHost ? '<div class="badge">호스트</div>' : ''}
        <div class="name">${escapeHtml(p.nickname)}${p.id === state.playerId ? ' (나)' : ''}</div>
        <div class="score">${p.connected ? '접속 중' : '연결 끊김'}</div>
      `;
      grid.appendChild(div);
    });

    const startBtn = $('btn-start-game');
    const canStart = state.isHost && state.players.length >= 3 && state.players.length <= 4;
    startBtn.disabled = !canStart;
    startBtn.classList.toggle('hidden', !state.isHost);
    startBtn.textContent = state.players.length < 3
      ? `게임 시작 (최소 3명 필요, 현재 ${state.players.length}명)`
      : '게임 시작';
    $('lobby-wait-msg').classList.toggle('hidden', state.isHost);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- 렌더링: 플레이어 스트립 (게임 중) ----------
  function renderPlayersStrip(doneIds) {
    const strip = $('players-strip');
    strip.innerHTML = '';
    state.players.forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (doneIds && doneIds.includes(p.id) ? ' done' : '');
      chip.textContent = `${p.nickname}${p.id === state.playerId ? '(나)' : ''} ${doneIds && doneIds.includes(p.id) ? '✅' : ''} · ${p.score}점`;
      strip.appendChild(chip);
    });
  }

  // ---------- 토큰 제출 화면 ----------
  function renderTokenPanel(usedTokens) {
    setPanel('panel-tokens');
    $('phase-indicator').textContent = '토큰 제출';
    const box = $('token-buttons');
    box.innerHTML = '';
    const used = usedTokens || [];
    for (let n = 1; n <= 5; n += 1) {
      const btn = document.createElement('button');
      btn.className = 'token-btn';
      btn.textContent = n;
      btn.disabled = used.includes(n) || state.myTokenSubmitted;
      btn.addEventListener('click', () => {
        if (state.myTokenSubmitted) return;
        socket.emit('submit_token', { token: n });
        box.querySelectorAll('.token-btn').forEach((b) => { b.disabled = true; });
        btn.classList.add('selected');
      });
      box.appendChild(btn);
    }
    $('token-status').textContent = state.myTokenSubmitted
      ? '제출 완료! 다른 사람을 기다리는 중...'
      : '토큰 하나를 골라줘.';
    renderPlayersStrip(state.tokenDoneIds);
  }

  // ---------- 힌트 & 예측 화면 ----------
  function renderGuessPanel() {
    setPanel('panel-guess');
    $('phase-indicator').textContent = '합 예측';
    const list = $('hint-list');
    list.innerHTML = '';
    state.hints.forEach((h, i) => {
      const li = document.createElement('li');
      li.textContent = `힌트 ${i + 1}. ${h}`;
      list.appendChild(li);
    });
    const input = $('input-guess');
    input.disabled = state.myGuessSubmitted;
    $('btn-submit-guess').disabled = state.myGuessSubmitted;
    $('guess-status').textContent = state.myGuessSubmitted
      ? '제출 완료! 다른 사람을 기다리는 중...'
      : '힌트를 보고 합을 예측해줘. 제출 후에는 수정할 수 없어.';
    renderPlayersStrip(state.guessDoneIds);
  }

  function submitGuess() {
    if (state.myGuessSubmitted) return;
    const val = Number($('input-guess').value);
    if (!Number.isInteger(val)) return showToast('숫자를 입력해줘.', true);
    socket.emit('submit_guess', { guess: val });
  }

  // ---------- 동점 가위바위보 화면 ----------
  const RPS_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
  const RPS_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  const RPS_LABEL = { rock: '바위', paper: '보', scissors: '가위' };

  function renderTiebreakPanel(message) {
    setPanel('panel-tiebreak');
    $('phase-indicator').textContent = '동점 처리';
    $('tiebreak-message').textContent = message || '';
    const amContestant = state.tiebreakContestants.includes(state.playerId);
    $('tiebreak-rps-buttons').classList.toggle('hidden', !amContestant || !!state.tiebreakMyChoice);
    $('tiebreak-status').textContent = amContestant
      ? (state.tiebreakMyChoice ? '선택 완료! 결과를 기다리는 중...' : '가위/바위/보 중 하나를 선택해줘.')
      : '동점자들이 가위바위보로 순위를 정하는 중이야...';
    $('tiebreak-reveal-grid').classList.add('hidden');
    $('tiebreak-outcome').classList.add('hidden');
  }

  function renderTiebreakReveal(choices) {
    $('tiebreak-rps-buttons').classList.add('hidden');
    $('tiebreak-status').textContent = '';

    const shapesPresent = [...new Set(Object.values(choices))];
    const isDraw = shapesPresent.length !== 2;
    const winnerShape = isDraw ? null
      : (RPS_BEATS[shapesPresent[0]] === shapesPresent[1] ? shapesPresent[0] : shapesPresent[1]);

    const grid = $('tiebreak-reveal-grid');
    grid.innerHTML = '';
    state.tiebreakContestants.forEach((id) => {
      const player = state.players.find((p) => p.id === id);
      const choice = choices[id];
      const div = document.createElement('div');
      let cls = 'rps-reveal-card';
      if (!isDraw) cls += choice === winnerShape ? ' win' : ' lose';
      div.className = cls;
      div.innerHTML = `
        <span class="emoji">${RPS_EMOJI[choice] || '❓'}</span>
        <span class="name">${escapeHtml(player ? player.nickname : '???')}${id === state.playerId ? ' (나)' : ''}</span>
      `;
      grid.appendChild(div);
    });
    grid.classList.remove('hidden');

    const outcome = $('tiebreak-outcome');
    outcome.textContent = isDraw
      ? '🤝 무승부! 같은 사람들끼리 다시 대결해.'
      : `${RPS_LABEL[winnerShape]} 승리! 진 사람은 그 아래 순위로 확정돼.`;
    outcome.classList.remove('hidden');
  }

  // ---------- 라운드 결과 화면 ----------
  function renderResultPanel(payload) {
    setPanel('panel-result');
    $('phase-indicator').textContent = '라운드 결과';
    $('result-sum').textContent = `이번 라운드 실제 합: ${payload.sum}`;

    const hintsBox = $('result-hints');
    hintsBox.innerHTML = '';
    payload.hints.forEach((h, i) => {
      const div = document.createElement('div');
      div.className = 'hint-item ' + (h.isTrue ? 'true-hint' : 'false-hint');
      div.textContent = `힌트 ${i + 1}. ${h.text} `;
      const tag = document.createElement('span');
      tag.className = 'hint-tag';
      tag.textContent = h.isTrue ? '[참]' : '[거짓]';
      div.appendChild(tag);
      hintsBox.appendChild(div);
    });

    const table = $('result-table');
    let html = '<tr><th>순위</th><th>닉네임</th><th>낸 토큰</th><th>예측값</th><th>오차</th><th>점수</th></tr>';
    payload.ranking.forEach((r) => {
      const token = payload.tokens[r.id];
      const guess = payload.guesses[r.id];
      const isMe = r.id === state.playerId;
      html += `<tr class="${isMe ? 'me' : ''}"><td>${r.rank}등</td><td>${escapeHtml(r.nickname)}${isMe ? ' (나)' : ''}</td><td>${token}</td><td>${guess}</td><td>${r.diff}</td><td>+${r.points}</td></tr>`;
    });
    table.innerHTML = html;

    // 점수 갱신
    payload.totalScores.forEach((p) => {
      const found = state.players.find((pl) => pl.id === p.id);
      if (found) found.score = p.score;
    });
    renderPlayersStrip(null);

    // 히스토리 저장 및 렌더
    $('history-panel').classList.remove('hidden');
    renderHistory();
  }

  function renderHistory() {
    const box = $('history-content');
    box.innerHTML = '';
    state.history.slice().reverse().forEach((h) => {
      const div = document.createElement('div');
      div.className = 'history-entry';
      const tokenStr = state.players.map((p) => `${p.nickname}: ${h.tokens[p.id]}`).join(' / ');
      const rankStr = h.ranking.map((r) => `${r.rank}등 ${r.nickname}(+${r.points})`).join(', ');
      div.innerHTML = `<b>라운드 ${h.round}</b> — 합 ${h.sum}<br>낸 토큰: ${tokenStr}<br>순위: ${rankStr}`;
      box.appendChild(div);
    });
  }

  // ---------- 게임 종료 화면 ----------
  function renderEnd(payload) {
    showScreen('end');
    const board = $('final-scoreboard');
    board.innerHTML = '';
    payload.finalScores.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'final-row' + (idx === 0 ? ' winner' : '');
      row.innerHTML = `
        <span class="rank">${idx + 1}</span>
        <span class="name">${idx === 0 ? '👑 ' : ''}${escapeHtml(p.nickname)}${p.id === state.playerId ? ' (나)' : ''}</span>
        <span class="score">${p.score}점</span>
      `;
      board.appendChild(row);
    });

    const summary = $('round-summary');
    summary.innerHTML = '<b>라운드별 요약</b><br>' + payload.history.map((h) => {
      const top = h.ranking[0];
      return `라운드 ${h.round}: 합 ${h.sum} · 1등 ${escapeHtml(top.nickname)}`;
    }).join('<br>');

    $('btn-rematch').classList.toggle('hidden', !state.isHost);
    $('rematch-wait-msg').classList.toggle('hidden', state.isHost);
  }

  // ---------- 이벤트 바인딩: 시작 화면 ----------
  $('btn-create-room').addEventListener('click', () => {
    const nickname = $('input-nickname').value.trim();
    if (!nickname) return showToast('닉네임을 입력해줘.', true);
    state.nickname = nickname;
    socket.emit('create_room', { nickname });
  });

  $('btn-join-room').addEventListener('click', () => {
    const nickname = $('input-nickname').value.trim();
    const roomCode = $('input-room-code').value.trim();
    if (!nickname) return showToast('닉네임을 입력해줘.', true);
    if (!/^[0-9]{4}$/.test(roomCode)) return showToast('방번호 4자리를 정확히 입력해줘.', true);
    state.nickname = nickname;
    socket.emit('join_room', { roomCode, nickname });
  });

  $('btn-start-game').addEventListener('click', () => {
    socket.emit('start_game');
  });

  $('copy-room-btn').addEventListener('click', () => {
    if (!state.roomCode) return;
    const done = () => showToast('방번호를 복사했어!');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.roomCode).then(done).catch(() => showToast('복사에 실패했어.', true));
    } else {
      const ta = document.createElement('textarea');
      ta.value = state.roomCode;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  });

  $('btn-submit-guess').addEventListener('click', submitGuess);
  $('input-guess').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGuess(); });

  document.querySelectorAll('.rps-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.tiebreakMyChoice) return;
      const choice = btn.dataset.choice;
      state.tiebreakMyChoice = choice;
      socket.emit('rps_choice', { choice });
      renderTiebreakPanel($('tiebreak-message').textContent);
    });
  });

  $('btn-rematch').addEventListener('click', () => {
    socket.emit('rematch');
  });

  // ---------- 소켓 이벤트 ----------
  socket.on('connect', () => {
    const savedRoom = localStorage.getItem(LS_ROOM);
    const savedPlayer = localStorage.getItem(LS_PLAYER);
    if (savedRoom && savedPlayer) {
      socket.emit('rejoin', { roomCode: savedRoom, playerId: savedPlayer });
    }
  });

  socket.on('joined', (data) => {
    state.roomCode = data.roomCode;
    state.playerId = data.playerId;
    state.isHost = data.isHost;
    saveSession();
    showScreen('lobby');
  });

  socket.on('lobby_update', (data) => {
    state.players = data.players;
    state.hostId = data.hostId;
    state.isHost = data.hostId === state.playerId;
    state.roomCode = data.roomCode;
    state.round = data.round;
    state.maxRounds = data.maxRounds;
    if (data.phase === 'lobby') {
      if (data.round === 0) state.history = [];
      showScreen('lobby');
      renderLobby();
    }
  });

  socket.on('state_sync', (data) => {
    state.players = data.players;
    state.hostId = data.hostId;
    state.isHost = data.hostId === state.playerId;
    state.round = data.round;
    state.maxRounds = data.maxRounds;
    state.hints = data.currentHints || [];
    state.myTokenSubmitted = data.myTokenSubmitted;
    state.myGuessSubmitted = data.myGuessSubmitted;
    state.history = data.history || [];

    if (data.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else if (data.phase === 'game_over') {
      showScreen('end');
    } else {
      showScreen('game');
      $('round-indicator').textContent = `라운드 ${state.round}/${state.maxRounds}`;
      if (data.phase === 'submitting_tokens') renderTokenPanel([]);
      else if (data.phase === 'guessing') renderGuessPanel();
      else if (data.phase === 'tiebreak') renderTiebreakPanel('동점자들이 가위바위보 중이야.');
      else setPanel('panel-result');
    }
    showToast('재접속했어. 게임을 이어서 진행할 수 있어.');
  });

  socket.on('error_message', (data) => {
    showToast(data.message, true);
    $('start-error').textContent = data.message;
    $('start-error').classList.remove('hidden');
    if (data.message.includes('찾을 수 없') || data.message.includes('새로 시작')) {
      clearSession();
    }
  });

  socket.on('round_start', (data) => {
    state.round = data.round;
    state.maxRounds = data.maxRounds;
    state.players = data.players;
    state.myTokenSubmitted = false;
    state.myGuessSubmitted = false;
    state.tokenDoneIds = [];
    state.guessDoneIds = [];
    state.tiebreakMyChoice = null;
    showScreen('game');
    $('round-indicator').textContent = `라운드 ${state.round}/${state.maxRounds}`;
    const me = state.players.find((p) => p.id === state.playerId);
    const usedByMe = me ? (5 - me.tokensLeft) : 0;
    // usedTokens 목록은 서버가 개인별로 관리하므로, 버튼에서 개별 비활성화는
    // token_progress/round_result 데이터로 보정됨. 최초에는 tokensLeft로 유추.
    renderTokenPanelFromLeft(me ? me.tokensLeft : 5);
    if (state.round === 1) {
      state.history = [];
      $('history-panel').classList.add('hidden');
    }
  });

  function renderTokenPanelFromLeft() {
    // 정확한 사용 토큰 목록은 서버가 알고 있으므로, 버튼은 일단 전부 활성화하고
    // 서버가 거부하면(submit_token 에러) 안내 메시지로 처리한다.
    renderTokenPanel([]);
  }

  socket.on('token_progress', (data) => {
    state.tokenDoneIds = data.submitted;
    if (data.submitted.includes(state.playerId)) {
      state.myTokenSubmitted = true;
      $('token-status').textContent = '제출 완료! 다른 사람을 기다리는 중...';
    }
    renderPlayersStrip(state.tokenDoneIds);
  });

  socket.on('guess_phase', (data) => {
    state.hints = data.hints;
    state.myTokenSubmitted = true;
    state.myGuessSubmitted = false;
    state.guessDoneIds = [];
    $('input-guess').value = '';
    renderGuessPanel();
  });

  socket.on('guess_progress', (data) => {
    state.guessDoneIds = data.submitted;
    if (data.submitted.includes(state.playerId)) {
      state.myGuessSubmitted = true;
      $('guess-status').textContent = '제출 완료! 다른 사람을 기다리는 중...';
      $('input-guess').disabled = true;
      $('btn-submit-guess').disabled = true;
    }
    renderPlayersStrip(state.guessDoneIds);
  });

  socket.on('phase_update', (data) => {
    if (data.phase === 'tiebreak') {
      renderTiebreakPanel(data.message);
    }
  });

  socket.on('tiebreak_prompt', (data) => {
    state.tiebreakContestants = data.contestants;
    state.tiebreakMyChoice = null;
    renderTiebreakPanel(data.message);
  });

  socket.on('tiebreak_progress', (data) => {
    $('tiebreak-status').textContent = `${data.chosenCount}/${data.total}명 선택 완료...`;
  });

  socket.on('tiebreak_reveal', (data) => {
    renderTiebreakReveal(data.choices);
  });

  socket.on('tiebreak_redo', (data) => {
    state.tiebreakContestants = data.contestants;
    state.tiebreakMyChoice = null;
    renderTiebreakPanel('비겼어! 다시 가위바위보를 해줘.');
  });

  socket.on('tiebreak_next', (data) => {
    state.tiebreakContestants = data.contestants;
    state.tiebreakMyChoice = null;
    renderTiebreakPanel('다음 순위를 가리기 위해 다시 대결해줘.');
  });

  socket.on('round_result', (data) => {
    state.history.push(data);
    renderResultPanel(data);
  });

  socket.on('game_over', (data) => {
    renderEnd(data);
  });

  // 페이지를 떠날 때 명시적으로 나가지는 않음 (재접속 지원을 위해 세션 유지)
})();
