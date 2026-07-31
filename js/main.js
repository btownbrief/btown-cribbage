/* BTOWN CRIBBAGE — UI only. Every rule lives in engine.js (+ scoring.js);
 * Champ's brain lives in bot.js. This file renders state, handles taps,
 * paces the bot with timers, queues the scoring callouts, draws the Long
 * Trail pegging board, and saves/restores the game (the whole game state
 * is one JSON-serializable object, so localStorage resume is a stringify
 * away). */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, suitOf, WIN_SCORE,
} from './engine.js';
import { chooseMove } from './bot.js';
import { OnlineMatch, savedSession, clearSession, getName } from './rooms.js';
import { sound } from './audio.js';

const SAVE_KEY = 'btown-cribbage-save-v1';
const GAME = 'btown-cribbage';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is Champ

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_CHAR = { T: '10' };
const RANK_SORT = 'A23456789TJQK';

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };
const onlinePanel = $('onlinePanel');
const opTitle = $('opTitle');
const opName = $('opName');
const opCodeWrap = $('opCodeWrap');
const opCode = $('opCode');
const opError = $('opError');
const lobbyEl = $('lobby');
const lobbyCode = $('lobbyCode');
const rejoinBtn = $('rejoinBtn');

let G = null;             // { mode: 'bot' | 'pass' | 'online', state }
let selected = [];        // discard picks (card strings)
let passSeat = null;      // pass & play: whose hand is currently revealed
let botTimer = null;
let calloutTimer = null;
let eventQueue = [];      // scoring events waiting to be announced
let afterQueue = null;    // continuation once the queue drains
let busy = false;         // ignore taps while callouts/panels are running
let online = null;        // { match, myPlayer, hostPlayer } in a two-phone room
let panelIntent = 'host';
let pollErrors = 0;
let leaveTimer = null;
let showHighlightTimer = null;
let pendingDealSound = false;
let outcomeShown = false;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ---------------------------------------------------------------- helpers */

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isRed = (card) => suitOf(card) === 'H' || suitOf(card) === 'D';
const rankChar = (card) => RANK_CHAR[rankOf(card)] || rankOf(card);
const cardText = (card) => rankChar(card) + SUIT_CHAR[suitOf(card)];

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'Champ' : 'You';
  if (G.mode === 'online') {
    if (online && p === online.myPlayer) return 'You';
    return onlineOpponent().name || 'Your friend';
  }
  return 'Player ' + (p + 1);
}
function playerNameS(p) { // possessive-friendly subject ("Your" / "Champ's")
  if (G.mode === 'bot') return p === BOT ? "Champ's" : 'Your';
  if (G.mode === 'online') {
    if (online && p === online.myPlayer) return 'Your';
    const name = onlineOpponent().name;
    return name ? `${name}'s` : "Your friend's";
  }
  return 'Player ' + (p + 1) + "'s";
}

function humanTurn() {
  if (!G || getStatus(G.state).status !== 'active') return false;
  if (G.mode === 'online') {
    return !!online && !online.pushing &&
      online.match.status === 'playing' && G.state.turn === online.myPlayer;
  }
  return (
    !(G.mode === 'bot' && G.state.turn === BOT) &&
    !(G.mode === 'pass' && passSeat !== G.state.turn)
  );
}

function onlineOpponent() {
  return online ? (online.match.opponents()[0] || {}) : {};
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

function save() {
  try {
    if (G && G.mode !== 'online' && getStatus(G.state).status === 'active') {
      localStorage.setItem(SAVE_KEY, JSON.stringify(G));
    } else if (!G || G.mode !== 'online') {
      localStorage.removeItem(SAVE_KEY);
    }
  } catch (e) { /* private mode etc. — play on without saving */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.state?.version === 1 && getStatus(saved.state).status === 'active') return saved;
  } catch (e) { /* corrupted save — ignore it */ }
  return null;
}

/* ------------------------------------------------------- the trail board
 * The Long Trail winds up the Green Mountains in five switchbacks, hole 0
 * at the trailhead, 121 at the summit. Geometry is computed analytically
 * (straight legs + semicircular turns) so the hole positions and the
 * drawn trail always agree. Two parallel tracks, one per player. */

const BOARD = { holes: null, pegs: null };

function trailSegments() {
  const rows = [136, 112, 88, 64, 40];
  const L = 38, R = 322, r = 12;
  const segs = [];
  const straight = (x1, y, x2) => segs.push({
    len: Math.abs(x2 - x1),
    at: (t) => ({ x: x1 + (x2 - x1) * t, y, dx: Math.sign(x2 - x1), dy: 0 }),
  });
  const turn = (cx, cy, from, to) => segs.push({
    len: Math.PI * r,
    at: (t) => {
      const a = from + (to - from) * t;
      return {
        x: cx + r * Math.cos(a), y: cy + r * Math.sin(a),
        dx: -Math.sin(a) * Math.sign(to - from), dy: Math.cos(a) * Math.sign(to - from),
      };
    },
  });
  straight(20, rows[0], R);                              // leg 1 →
  turn(R, rows[0] - r, Math.PI / 2, -Math.PI / 2);       // right turn up
  straight(R, rows[1], L);                               // leg 2 ←
  turn(L, rows[1] - r, Math.PI / 2, Math.PI * 1.5);      // left turn up
  straight(L, rows[2], R);                               // leg 3 →
  turn(R, rows[2] - r, Math.PI / 2, -Math.PI / 2);
  straight(R, rows[3], L);                               // leg 4 ←
  turn(L, rows[3] - r, Math.PI / 2, Math.PI * 1.5);
  straight(L, rows[4], 306);                             // summit leg →
  return segs;
}

function trailPoint(segs, total, dist) {
  let d = Math.max(0, Math.min(dist, total - 0.001));
  for (const seg of segs) {
    if (d <= seg.len) return seg.at(d / seg.len);
    d -= seg.len;
  }
  return segs[segs.length - 1].at(1);
}

function buildBoard() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 360 158');

  const segs = trailSegments();
  const total = segs.reduce((sum, seg) => sum + seg.len, 0);

  // ridgelines behind the trail
  const ridges = [
    ['M0 158 L48 70 L96 128 L150 52 L214 122 L268 44 L330 118 L360 84 L360 158 Z', 'rgba(29, 107, 63, 0.16)'],
    ['M0 158 L70 96 L128 140 L200 78 L262 134 L322 88 L360 130 L360 158 Z', 'rgba(18, 53, 36, 0.14)'],
  ];
  for (const [d, fill] of ridges) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill);
    svg.appendChild(p);
  }
  // a few pines along the meadows
  for (const [x, y] of [[176, 128], [70, 100], [250, 76], [140, 53], [330, 26]]) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('font-size', '10');
    t.setAttribute('opacity', '0.6');
    t.textContent = '🌲';
    svg.appendChild(t);
  }

  // the trail itself: polyline sampled from the same geometry as the holes
  let d = '';
  for (let i = 0; i <= 240; i++) {
    const pt = trailPoint(segs, total, (total * i) / 240);
    d += (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1);
  }
  const band = document.createElementNS(NS, 'path');
  band.setAttribute('d', d);
  band.setAttribute('fill', 'none');
  band.setAttribute('stroke', '#c9a36c');
  band.setAttribute('stroke-width', '14');
  band.setAttribute('stroke-linecap', 'round');
  band.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(band);
  const edge = document.createElementNS(NS, 'path');
  edge.setAttribute('d', d);
  edge.setAttribute('fill', 'none');
  edge.setAttribute('stroke', 'rgba(122, 92, 51, 0.5)');
  edge.setAttribute('stroke-width', '15.5');
  edge.setAttribute('stroke-linecap', 'round');
  edge.setAttribute('stroke-dasharray', '0.1 6');
  svg.insertBefore(edge, band);

  // peg holes: two parallel tracks, hole i at score i (0 = trailhead)
  BOARD.holes = [[], []];
  const spacing = total / (WIN_SCORE + 0.5);
  for (let i = 0; i <= WIN_SCORE; i++) {
    const pt = trailPoint(segs, total, spacing * i);
    const nx = pt.dy, ny = -pt.dx; // left of travel
    for (const p of [0, 1]) {
      const off = p === 0 ? 3.6 : -3.6;
      BOARD.holes[p][i] = { x: pt.x + nx * off, y: pt.y + ny * off };
    }
    if (i > 0 && i % 5 === 0) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
      c.setAttribute('r', i % 30 === 0 ? 2 : 1.1);
      c.setAttribute('fill', 'rgba(90, 66, 34, 0.5)');
      svg.appendChild(c);
    }
  }

  // mile markers + summit + the skunk line
  const label = (x, y, text, size = 8, weight = 900, fill = 'rgba(70, 50, 24, 0.85)') => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('font-size', size);
    t.setAttribute('font-weight', weight);
    t.setAttribute('fill', fill);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'inherit');
    t.textContent = text;
    svg.appendChild(t);
  };
  for (const mark of [30, 60, 90]) {
    const pt = trailPoint(segs, total, spacing * mark);
    label(pt.x, pt.y - 11, String(mark));
  }
  const skunkPt = trailPoint(segs, total, spacing * 91);
  label(skunkPt.x, skunkPt.y + 17, '🦨 91', 7.5, 800, 'rgba(70, 50, 24, 0.7)');
  const start = trailPoint(segs, total, 0);
  label(start.x + 2, start.y + 17, 'TRAILHEAD', 6.5, 800, 'rgba(70, 50, 24, 0.7)');
  const summit = trailPoint(segs, total, total);
  label(summit.x + 22, summit.y + 3, '⛰️ 121', 9);

  // pegs: two per player, front and back, leapfrogging up the trail
  BOARD.pegs = {};
  for (const p of [0, 1]) {
    for (const which of ['back', 'front']) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `peg p${p} ${which}`);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', which === 'front' ? 4 : 3.1);
      g.appendChild(c);
      svg.appendChild(g);
      BOARD.pegs[`${p}-${which}`] = g;
    }
  }

  $('board').innerHTML = '';
  $('board').appendChild(svg);
}

function updatePegs() {
  if (!BOARD.holes) return;
  const s = G.state;
  for (const p of [0, 1]) {
    const front = BOARD.holes[p][Math.min(s.scores[p], WIN_SCORE)];
    const back = BOARD.holes[p][Math.min(s.prevScores[p], WIN_SCORE)];
    BOARD.pegs[`${p}-front`].style.transform = `translate(${front.x}px, ${front.y}px)`;
    const bump = s.scores[p] === s.prevScores[p] ? -4 : 0; // both at start: nestle them
    BOARD.pegs[`${p}-back`].style.transform = `translate(${back.x + bump}px, ${back.y}px)`;
  }
}

function resetEffects() {
  clearTimeout(showHighlightTimer);
  showHighlightTimer = null;
  document.querySelectorAll('.score-flight, #leaves .leaf').forEach((el) => el.remove());
  $('board').classList.remove('summit-result', 'summit-celebrate', 'winner-p0', 'winner-p1', 'skunk-win');
}

$('mute').addEventListener('click', () => {
  const isMuted = sound.toggleMuted();
  $('mute').textContent = isMuted ? '🔇' : '🔊';
  $('mute').setAttribute('aria-pressed', String(isMuted));
  $('mute').setAttribute('aria-label', isMuted ? 'Unmute sound' : 'Mute sound');
});
$('mute').textContent = sound.muted ? '🔇' : '🔊';
$('mute').setAttribute('aria-pressed', String(sound.muted));
$('mute').setAttribute('aria-label', sound.muted ? 'Unmute sound' : 'Mute sound');
document.addEventListener('pointerdown', sound.unlock, { once: true, capture: true });
document.addEventListener('keydown', sound.unlock, { once: true, capture: true });

/* ---------------------------------------------------------------- cards */

function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card ' + (isRed(card) ? 'red' : 'black');
  el.dataset.card = card;
  const r = rankChar(card);
  const s = SUIT_CHAR[suitOf(card)];
  el.innerHTML =
    `<div class="corner">${r}<br>${s}</div>` +
    `<div class="pip">${s}</div>` +
    `<div class="corner flip">${r}<br>${s}</div>`;
  return el;
}

function sortedHand(hand) {
  return hand.slice().sort((a, b) =>
    (RANK_SORT.indexOf(rankOf(a)) - RANK_SORT.indexOf(rankOf(b))) ||
    suitOf(a).localeCompare(suitOf(b)));
}

/* ---------------------------------------------------------------- render */

function render(fx = {}) {
  const s = G.state;
  const status = getStatus(s);
  const moves = legalMoves(s);
  const myTurn = humanTurn();
  const canAdvance = G.mode !== 'online' || myTurn;

  // player chips
  const chips = $('players');
  chips.innerHTML = '';
  const playerOrder = G.mode === 'online' ? [1 - online.myPlayer, online.myPlayer] : [0, 1];
  for (const p of playerOrder) {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (status.status === 'active' && s.turn === p ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = `dot p${p}`;
    const name = document.createElement('span');
    name.textContent = G.mode === 'bot' && p === BOT ? '🐉 Champ' : playerName(p);
    chip.append(dot, name);
    if (s.dealer === p) {
      const crib = document.createElement('span');
      crib.className = 'crib-tag';
      crib.title = `${playerNameS(p)} crib`;
      crib.textContent = '🧺';
      chip.appendChild(crib);
    }
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = s.scores[p];
    chip.appendChild(score);
    chips.appendChild(chip);
  }

  if (fx.instantPegs) $('board').classList.add('instant-pegs');
  updatePegs();
  if (fx.instantPegs) {
    void $('board').offsetWidth;
    $('board').classList.remove('instant-pegs');
  }

  // deck + starter
  const cuttable = s.phase === 'cut' && myTurn;
  $('deckPile').classList.toggle('cuttable', cuttable);
  const slot = $('starterSlot');
  slot.innerHTML = '';
  if (s.starter) {
    const el = cardEl(s.starter);
    if (fx.flipStarter) el.classList.add('flip-in');
    slot.appendChild(el);
  }

  // the play pile + count
  const inPlay = s.phase === 'play';
  $('countBadge').classList.toggle('hidden', !inPlay);
  if (inPlay) {
    $('countNum').textContent = s.play.count;
    $('countBadge').classList.toggle('hot', s.play.count >= 25);
  }
  const pile = $('pile');
  pile.innerHTML = '';
  if (inPlay) {
    const spent = s.play.prevPiles.length > 0 && s.play.pile.length === 0
      ? s.play.prevPiles[s.play.prevPiles.length - 1].slice(-3) : [];
    for (const entry of spent) {
      const el = cardEl(entry.card);
      el.classList.add('spent');
      pile.appendChild(el);
    }
    s.play.pile.forEach((entry, i) => {
      const el = cardEl(entry.card);
      if (fx.slap && i === s.play.pile.length - 1) el.classList.add('slap');
      pile.appendChild(el);
    });
  }

  // action buttons
  const onlyGo = inPlay && myTurn && moves.length === 1 && moves[0].type === 'go';
  $('goBtn').classList.toggle('hidden', !onlyGo);
  $('cribBtn').classList.toggle('hidden', !(s.phase === 'discard' && myTurn));
  $('cribBtn').disabled = selected.length !== 2;
  $('cribBtn').textContent = selected.length === 2
    ? `🧺 TOSS ${cardText(selected[0])} ${cardText(selected[1])} → ${playerNameS(s.dealer).toUpperCase()} CRIB`
    : `🧺 PICK 2 FOR ${playerNameS(s.dealer).toUpperCase()} CRIB`;
  $('countBtn').classList.toggle('hidden', !(s.phase === 'show' && canAdvance && !busy));
  if (s.phase === 'show') {
    const pone = 1 - s.dealer;
    const who = s.showStep === 0 ? playerNameS(pone) : playerNameS(s.dealer);
    $('countBtn').textContent = s.showStep === 2
      ? `🔢 COUNT ${playerNameS(s.dealer).toUpperCase()} CRIB`
      : `🔢 COUNT ${who.toUpperCase()} HAND`;
  }
  $('dealBtn').classList.toggle('hidden', !(s.phase === 'handDone' && canAdvance && !busy));
  if (s.phase === 'handDone') {
    const next = playerName(1 - s.dealer);
    $('dealBtn').textContent = `🃏 NEXT HAND — ${next.toUpperCase()} DEAL${next === 'You' ? '' : 'S'}`;
  }

  renderHand(fx);
  renderMessage(moves, myTurn);
}

function renderHand(fx = {}) {
  const s = G.state;
  const myTurn = humanTurn();
  const handEl = $('hand');
  handEl.innerHTML = '';

  // whose hand sits at the bottom of the screen?
  let owner = G.mode === 'bot' ? 0 : (G.mode === 'online' ? online.myPlayer : s.turn);
  let revealed = true;
  if (G.mode === 'pass') {
    if (s.phase === 'cut' || s.phase === 'show' || s.phase === 'handDone') revealed = false;
    else revealed = passSeat === s.turn;
  }
  if (s.phase === 'show' || s.phase === 'handDone') {
    // cards are on the table; show the kept hand face-up for reference
    if (G.mode === 'bot' || G.mode === 'online') {
      $('handLabel').textContent = 'your hand (counted with the starter)';
      const owner = G.mode === 'online' ? online.myPlayer : 0;
      for (const card of sortedHand(s.showHands[owner])) handEl.appendChild(cardEl(card));
    } else {
      $('handLabel').textContent = '';
    }
    return;
  }

  $('handLabel').textContent = G.mode === 'bot' || G.mode === 'online'
    ? 'your hand'
    : (revealed ? playerNameS(owner).toLowerCase() + ' hand' : 'hands hidden — cut when ready');
  if (!revealed) return;

  const hand = sortedHand(s.hands[owner]);
  const moves = legalMoves(s);
  const playable = new Set(
    s.turn === owner ? moves.filter((m) => m.type === 'play').map((m) => m.card) : [],
  );

  hand.forEach((card, i) => {
    const el = cardEl(card);
    if (s.phase === 'discard') {
      if (selected.includes(card)) el.classList.add('picked');
    } else if (s.phase === 'play' && myTurn && s.turn === owner) {
      if (playable.has(card)) el.classList.add('playable');
      else el.classList.add('dim');
    }
    if (fx.dealAll) { el.classList.add('deal-in'); el.style.animationDelay = (i * 45) + 'ms'; }
    el.addEventListener('click', () => onCardTap(card, el));
    handEl.appendChild(el);
  });
}

function renderMessage(moves, myTurn) {
  const s = G.state;
  let line = '';

  switch (s.phase) {
    case 'discard': {
      const viewer = G.mode === 'bot' ? 0 : (G.mode === 'online' ? online.myPlayer : s.turn);
      const cribWho = s.dealer === viewer
        ? "It's your crib — a little generosity pays."
        : (G.mode === 'bot' ? "Champ's crib — don't feed the monster." : "Their crib — toss them table scraps.");
      line = myTurn
        ? `Pick 2 cards to toss. ${cribWho}`
        : (G.mode === 'online' ? onlineWait('is picking a toss') : 'Champ is picking his toss…');
      break;
    }
    case 'cut':
      line = myTurn
        ? 'Tap the deck to cut the starter card.'
        : (G.mode === 'online' ? onlineWait('is cutting the starter') : 'Champ reaches over to cut…');
      break;
    case 'play':
      if (myTurn) {
        const onlyGo = moves.length === 1 && moves[0].type === 'go';
        line = onlyGo
          ? "Nothing fits under 31 — say go."
          : `${G.mode === 'pass' ? playerName(s.turn) + ': play' : 'Play'} a card. 15s, pairs and runs peg points.`;
      } else {
        line = G.mode === 'online' ? onlineWait('is studying the count') : 'Champ studies his cards…';
      }
      break;
    case 'show': {
      const pone = 1 - s.dealer;
      if (G.mode === 'online' && !myTurn) {
        line = onlineWait(s.showStep === 2 ? 'is counting the crib' : 'is counting a hand');
      } else {
        line = s.showStep === 0
          ? `Time to count. ${playerNameS(pone)} hand goes first — them's the rules.`
          : (s.showStep === 1 ? `Now ${playerNameS(s.dealer).toLowerCase()} hand.` : `And ${playerNameS(s.dealer).toLowerCase()} crib to finish.`);
      }
      break;
    }
    case 'handDone':
      line = G.mode === 'online' && !myTurn
        ? onlineWait('has the next deal')
        : `Hand ${s.handNumber} in the books. The deal passes on.`;
      break;
  }
  $('msg').textContent = line;
}

function onlineWait(action) {
  const opp = onlineOpponent();
  const name = opp.name || 'Your friend';
  return opp.away ? `${name} stepped away — hang tight…` : `${name} ${action}…`;
}

/* -------------------------------------------------------- scoring callouts */

const CALLOUT_TEXT = {
  heels: () => 'HIS HEELS!',
  fifteen: () => 'FIFTEEN — TWO!',
  pair: (e) => (e.points === 12 ? 'DOUBLE PAIRS ROYAL!' : e.points === 6 ? 'PAIRS ROYAL!' : 'A PAIR!'),
  run: (e) => `RUN OF ${e.points}!`,
  thirtyone: () => 'THIRTY-ONE!',
  go: () => 'GO — ONE POINT',
  lastcard: () => 'ONE FOR LAST CARD',
};

function processEvents(events, done) {
  const presentable = events.filter((e) => e.kind !== 'win');
  if (presentable.length > 1 && presentable.every((e) => e.kind !== 'show')) {
    const points = presentable.reduce((sum, e) => sum + (e.points || 0), 0);
    eventQueue = [{
      kind: 'turn',
      player: presentable[0].player,
      points,
      label: 'this turn',
      parts: presentable,
    }];
  } else {
    eventQueue = presentable;
  }
  afterQueue = done;
  busy = true;
  nextEvent();
}

function nextEvent() {
  const e = eventQueue.shift();
  if (!e) {
    busy = false;
    $('callout').classList.add('hidden');
    const done = afterQueue;
    afterQueue = null;
    if (done) done();
    return;
  }
  if (e.kind === 'show') { openShowPanel(e); return; }

  const text = CALLOUT_TEXT[e.kind] ? CALLOUT_TEXT[e.kind](e) : e.label.toUpperCase();
  const co = $('callout');
  const tier = e.points >= 9 ? 'tier-summit' : e.points >= 5 ? 'tier-big' : e.points <= 1 ? 'tier-quiet' : 'tier-standard';
  co.className = `${e.player === 1 ? 'for-p1 ' : ''}${tier}`;
  co.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'co-label';
  label.textContent = e.kind === 'turn' ? `+${e.points} THIS TURN` : text;
  co.appendChild(label);
  if (e.kind === 'turn') {
    const points = document.createElement('span');
    points.className = 'co-pts';
    points.textContent = `${e.parts.map((part) => CALLOUT_TEXT[part.kind]?.(part) || part.label).join(' + ')} • ${playerName(e.player)}`;
    co.appendChild(points);
  } else if (e.points) {
    const points = document.createElement('span');
    points.className = 'co-pts';
    points.textContent = `+${e.points} for ${playerName(e.player)}`;
    co.appendChild(points);
  }
  co.classList.remove('hidden');
  co.style.animation = 'none'; void co.offsetWidth; co.style.animation = '';
  sound.callout(e.kind, e.points);
  flyScore(e.points, e.player, co);
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(nextEvent, 1050);
}

function flyScore(points, player, source) {
  if (!points || reducedMotion.matches || !BOARD.pegs) return;
  const from = source.getBoundingClientRect();
  const game = $('game').getBoundingClientRect();
  const svg = $('board').querySelector('svg');
  const hole = BOARD.holes[player][Math.min(G.state.scores[player], WIN_SCORE)];
  const point = svg.createSVGPoint();
  point.x = hole.x;
  point.y = hole.y;
  const target = point.matrixTransform(svg.getScreenCTM());
  const fromX = from.left + from.width / 2;
  const fromY = from.top + from.height / 2;
  const chip = document.createElement('span');
  chip.className = `score-flight p${player}`;
  chip.textContent = `+${points}`;
  chip.setAttribute('aria-hidden', 'true');
  chip.style.left = `${fromX - game.left}px`;
  chip.style.top = `${fromY - game.top}px`;
  chip.style.setProperty('--fly-x', `${target.x - fromX}px`);
  chip.style.setProperty('--fly-y', `${target.y - fromY}px`);
  chip.addEventListener('animationend', () => chip.remove(), { once: true });
  $('game').appendChild(chip);
}

/* --------------------------------------------------------- the show panel */

function openShowPanel(e) {
  sound.callout('show', e.points);
  $('showTitle').textContent =
    `${playerNameS(e.player)} ${e.role === 'crib' ? 'crib' : 'hand'} — ${e.points} point${e.points === 1 ? '' : 's'}`;

  const cardsRow = $('showCards');
  cardsRow.innerHTML = '';
  const list = $('showItems');
  list.innerHTML = '';
  const privateOpponentHand =
    G.mode === 'online' && e.role === 'hand' && e.player !== online.myPlayer;
  cardsRow.classList.toggle('hidden', privateOpponentHand);
  if (privateOpponentHand) {
    const div = document.createElement('div');
    div.className = 'show-item zero';
    div.textContent = "Their hand stays on their phone — the engine counted it.";
    list.appendChild(div);
    $('showTotal').innerHTML = `TOTAL — <b>${e.points}</b>`;
    $('showTotal').style.animationDelay = '120ms';
    $('showPanel').classList.remove('hidden');
    return;
  }

  for (const card of sortedHand(e.cards)) cardsRow.appendChild(cardEl(card));
  const starterEl = cardEl(e.starter);
  starterEl.classList.add('starter-card');
  starterEl.title = 'the starter';
  cardsRow.appendChild(starterEl);

  if (e.breakdown.items.length === 0) {
    const div = document.createElement('div');
    div.className = 'show-item zero';
    div.textContent = '“Nineteen!” — cribbage for a big fat zero.';
    list.appendChild(div);
  }
  e.breakdown.items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'show-item';
    div.style.animationDelay = (i * 90) + 'ms';
    div.innerHTML =
      `<span>${item.label}</span>` +
      `<span class="si-cards">${item.cards.map(cardText).join(' ')}</span>` +
      `<span class="si-pts">+${item.points}</span>`;
    div.addEventListener('animationstart', () => highlightShowCards(item.cards));
    div.addEventListener('pointerenter', () => highlightShowCards(item.cards));
    list.appendChild(div);
  });
  if (reducedMotion.matches && e.breakdown.items[0]) {
    highlightShowCards(e.breakdown.items[0].cards, true);
  }
  $('showTotal').innerHTML = `TOTAL — <b>${e.points}</b>`;
  $('showTotal').style.animationDelay = (e.breakdown.items.length * 90 + 120) + 'ms';
  $('showPanel').classList.remove('hidden');
}

function highlightShowCards(cards, keep = false) {
  clearTimeout(showHighlightTimer);
  const wanted = new Set(cards);
  $('showCards').querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('combo-card', wanted.has(card.dataset.card));
    card.classList.toggle('combo-dim', !wanted.has(card.dataset.card));
  });
  if (!keep) {
    showHighlightTimer = setTimeout(() => {
      $('showCards').querySelectorAll('.card').forEach((card) => {
        card.classList.remove('combo-card', 'combo-dim');
      });
    }, 520);
  }
}

$('showNextBtn').addEventListener('click', () => {
  clearTimeout(showHighlightTimer);
  showHighlightTimer = null;
  $('showPanel').classList.add('hidden');
  nextEvent();
});

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  clearTimeout(botTimer);
  G.state = applyMove(G.state, move);
  save();
  if (online) pushOnline();

  const fx = {};
  if (move.type === 'play') fx.slap = true;
  if (move.type === 'cut') fx.flipStarter = true;
  if (move.type === 'deal') fx.dealAll = true;
  if (move.type === 'discard') selected = [];
  if (move.type === 'play') sound.slap();
  if (move.type === 'deal') {
    if (G.mode === 'pass') pendingDealSound = true;
    else sound.deal();
  }
  render(fx);

  processEvents(G.state.lastEvents, () => {
    render(); // buttons hidden while busy come back
    const status = getStatus(G.state);
    if (status.status !== 'active') { showGameOver(status); return; }
    scheduleNext(move);
  });
}

/* After a move (and its callouts): hand off the phone, wake the bot, or
 * just wait for the next human tap. */
function scheduleNext(lastMove) {
  const s = G.state;
  if (G.mode === 'bot') {
    const botActs = s.turn === BOT && ['discard', 'cut', 'play'].includes(s.phase);
    if (botActs) botTimer = setTimeout(botStep, s.phase === 'play' ? 850 : 650);
    return;
  }
  if (G.mode === 'online') return;
  // pass & play: interstitial before revealing a different player's cards
  if (['discard', 'cut', 'play'].includes(s.phase) && passSeat !== s.turn) {
    showHandoff(s.turn);
  }
}

function botStep() {
  if (!G || G.mode !== 'bot' || busy) return;
  if (getStatus(G.state).status !== 'active' || G.state.turn !== BOT) return;
  if (!['discard', 'cut', 'play'].includes(G.state.phase)) return;
  const move = chooseMove(G.state);
  if (move) doMove(move);
}

function onCardTap(card, el) {
  if (!humanTurn() || busy) return;
  const s = G.state;

  if (s.phase === 'discard') {
    if (selected.includes(card)) {
      selected = selected.filter((c) => c !== card);
    } else if (selected.length < 2) {
      selected.push(card);
    } else {
      selected = [selected[1], card]; // roll the oldest pick off
    }
    render();
    return;
  }

  if (s.phase === 'play') {
    const legal = legalMoves(s).some((m) => m.type === 'play' && m.card === card);
    if (!legal) {
      el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope');
      return;
    }
    doMove({ type: 'play', card });
  }
}

$('deckPile').addEventListener('click', () => {
  if (busy || !G) return;
  if (G.state.phase === 'cut' && humanTurn()) doMove({ type: 'cut' });
});

$('goBtn').addEventListener('click', () => {
  if (busy || !humanTurn()) return;
  if (legalMoves(G.state).some((m) => m.type === 'go')) doMove({ type: 'go' });
});

$('cribBtn').addEventListener('click', () => {
  if (busy || !humanTurn() || selected.length !== 2) return;
  doMove({ type: 'discard', cards: selected.slice() });
});

$('countBtn').addEventListener('click', () => {
  if (busy || !G || G.state.phase !== 'show') return;
  if (G.mode === 'online' && !humanTurn()) return;
  doMove({ type: 'count' });
});

$('dealBtn').addEventListener('click', () => {
  if (busy || !G || G.state.phase !== 'handDone') return;
  if (G.mode === 'online' && !humanTurn()) return;
  if (G.mode === 'pass') passSeat = null;
  doMove({ type: 'deal' });
});

/* ---------------------------------------------------------------- flow */

function startGame(mode) {
  clearTimeout(botTimer);
  clearTimeout(calloutTimer);
  selected = [];
  passSeat = null;
  busy = false;
  pendingDealSound = mode === 'pass';
  outcomeShown = false;
  sound.stop();
  resetEffects();
  G = { mode, state: createInitialState({ seed: newSeed() }) };
  save();
  if (!BOARD.holes) buildBoard();
  if (mode === 'pass') {
    showHandoff(G.state.turn);
  } else {
    show('game');
    sound.deal();
    render({ dealAll: true });
    scheduleNext(null);
  }
}

function showHandoff(player, animateReveal = true) {
  passSeat = null;
  $('handoffTitle').textContent = 'Pass the phone to ' + playerName(player);
  $('handoffBtn').dataset.animateReveal = animateReveal ? '1' : '0';
  show('handoff');
}

$('handoffBtn').addEventListener('click', () => {
  passSeat = G.state.turn;
  show('game');
  if (pendingDealSound) {
    sound.deal();
    pendingDealSound = false;
  }
  const animateReveal = $('handoffBtn').dataset.animateReveal === '1';
  render(animateReveal ? { dealAll: true } : { instantPegs: true });
});

/* ---------------------------------------------------------------- game over */

const WIN_LINES = [
  'Summit reached — the view from 121 is all Champlain.',
  'Pegged out smoother than fresh corduroy at Bolton.',
  'That’s a Green Mountain masterclass in counting.',
  'Sweeter than syrup on snow, that finish.',
];
const SKUNK_LINES = [
  'A SKUNK! They never even made it past the 91 marker — left at the trailhead with wet boots.',
  'A SKUNK! Shut out below 91. Somewhere on Church Street, a bell tolls for them.',
];

function showGameOver(status, { celebrate = true } = {}) {
  if (outcomeShown) return;
  outcomeShown = true;
  clearTimeout(botTimer);
  save(); // clears the save — game's done
  $('againBtn').classList.remove('hidden');
  const winner = status.winner;
  const line = $('go-line');
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  if (G.mode === 'bot' && winner === BOT) {
    $('go-title').textContent = status.skunk ? 'SKUNKED BY CHAMP' : 'CHAMP SUMMITS FIRST';
    line.textContent = status.skunk
      ? 'Under 91?! The lake monster counted you right off the mountain. Demand a rematch.'
      : 'The lake monster pegged out first. He’s been playing since the steamboat days — rematch?';
  } else if (G.mode === 'bot') {
    $('go-title').textContent = status.skunk ? 'YOU SKUNKED CHAMP! 🦨' : 'YOU SUMMIT! ⛰️';
    line.textContent = status.skunk
      ? 'Champ never reached the 91 marker. That’s a story they’ll tell at the ECHO Center.'
      : pick(WIN_LINES) + ' Champ tips his fins to you.';
  } else if (G.mode === 'online') {
    const iWon = winner === online.myPlayer;
    $('go-title').textContent = iWon
      ? (status.skunk ? 'YOU DEALT A SKUNK! 🦨' : 'YOU SUMMIT! ⛰️')
      : `${playerName(winner).toUpperCase()} SUMMITS! ⛰️`;
    line.textContent = status.skunk
      ? (iWon ? 'They never reached 91. That is a proper Green Mountain skunk.' : pick(SKUNK_LINES))
      : pick(WIN_LINES);
  } else {
    $('go-title').textContent = playerName(winner).toUpperCase() + ' SUMMITS! ⛰️';
    line.textContent = status.skunk ? pick(SKUNK_LINES) : pick(WIN_LINES);
  }
  $('go-score').textContent = `${status.scores[0]} — ${status.scores[1]}`;
  show('gameover');
  screens.game.classList.remove('hidden');
  $('board').classList.add('summit-result', `winner-p${winner}`);
  $('board').classList.toggle('skunk-win', status.skunk);
  if (celebrate) {
    $('board').classList.add('summit-celebrate');
    sound.summit(G.mode === 'bot' ? winner !== BOT : (G.mode === 'online' ? winner === online.myPlayer : true));
    scatterLeaves();
  }
  $('againBtn').focus({ preventScroll: true });
}

function scatterLeaves() {
  if (reducedMotion.matches) return;
  const colors = ['maple', 'gold', 'green'];
  for (let i = 0; i < 24; i++) {
    const leaf = document.createElement('i');
    leaf.className = `leaf ${colors[i % colors.length]}`;
    leaf.style.left = `${(i * 37) % 101}%`;
    leaf.style.setProperty('--drift', `${((i * 29) % 90) - 45}px`);
    leaf.style.animationDelay = `${(i % 8) * 70}ms`;
    leaf.style.animationDuration = `${1500 + (i % 6) * 130}ms`;
    leaf.addEventListener('animationend', () => leaf.remove(), { once: true });
    $('leaves').appendChild(leaf);
  }
}

/* ---------------------------------------------------------------- menu */

$('botBtn').addEventListener('click', () => startGame('bot'));
$('passBtn').addEventListener('click', () => startGame('pass'));

$('resumeBtn').addEventListener('click', () => {
  const saved = loadSave();
  if (!saved) { $('resumeBtn').classList.add('hidden'); return; }
  G = saved;
  selected = [];
  passSeat = null;
  busy = false;
  pendingDealSound = false;
  outcomeShown = false;
  resetEffects();
  if (!BOARD.holes) buildBoard();
  if (G.mode === 'pass' && ['discard', 'cut', 'play'].includes(G.state.phase)) {
    showHandoff(G.state.turn, false);
  } else {
    show('game');
    render({ instantPegs: true });
    scheduleNext(null);
  }
});

function finishMenu() {
  clearTimeout(botTimer);
  clearTimeout(calloutTimer);
  sound.stop();
  resetEffects();
  eventQueue = [];
  afterQueue = null;
  busy = false;
  $('showPanel').classList.add('hidden');
  $('callout').classList.add('hidden');
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  refreshRejoin();
  show('menu');
}

function goMenu(button) {
  if (online && button) {
    // Leaving a live table ends it on both phones. A second tap confirms.
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.dataset.oldText = button.textContent;
      button.textContent = 'LEAVE?';
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        button.dataset.armed = '';
        button.textContent = button.dataset.oldText;
      }, 2500);
      return;
    }
    online.match.leave();
    online = null;
    G = null;
    button.dataset.armed = '';
    button.textContent = button.dataset.oldText;
  }
  finishMenu();
}

$('homeBtn').addEventListener('click', () => goMenu($('homeBtn')));
$('menuBtn').addEventListener('click', () => goMenu($('menuBtn')));
$('againBtn').addEventListener('click', () => {
  if (online) onlineRematch();
  else startGame(G.mode);
});

/* ------------------------------------------------------------- online play
 * Two phones share the engine's complete JSON state through rooms.js. The
 * honest UI only renders this phone's hand (the full state is still visible
 * to a determined devtools snoop, which is accepted for friendly games).
 * Room seat 0 is bound to whichever engine player acts first in the seeded
 * initial state; every later action is gated by the engine's current turn. */

$('hostBtn').addEventListener('click', () => openOnlinePanel('host'));
$('joinBtn').addEventListener('click', () => openOnlinePanel('join'));
$('opCancel').addEventListener('click', closeOnlinePanel);
$('opGo').addEventListener('click', onlineGo);
$('lobbyCancel').addEventListener('click', cancelLobby);
rejoinBtn.addEventListener('click', rejoinTable);
opCode.addEventListener('input', () => {
  opCode.value = opCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
[opName, opCode].forEach((el) => el.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') onlineGo();
}));

function openOnlinePanel(intent) {
  panelIntent = intent;
  opTitle.textContent = intent === 'host' ? 'START A TABLE' : 'JOIN A TABLE';
  $('opGo').textContent = intent === 'host' ? 'GET A CODE' : 'DEAL ME IN';
  opCodeWrap.classList.toggle('hidden', intent === 'host');
  opError.classList.add('hidden');
  opName.value = opName.value || getName();
  onlinePanel.classList.remove('hidden');
  (intent === 'join' && opName.value ? opCode : opName).focus();
}

function closeOnlinePanel() {
  onlinePanel.classList.add('hidden');
}

const FRIENDLY_ERRORS = {
  not_found: 'No table with that code — double-check the letters.',
  room_full: 'That table already has two players.',
  room_started: 'That game is already under way.',
  not_ready: "Online play isn't switched on yet — check back soon!",
  offline: "Can't reach the trail — are you online?",
};

function friendlyRoomError(err) {
  if (err && err.code === 'wrong_game') {
    return `That code is for ${String(err.detail || 'another game').replace(/-/g, ' ')} — head there to use it.`;
  }
  return (err && FRIENDLY_ERRORS[err.code]) || 'The cards blew off the table — please try again.';
}

function freshOnlineState(hostPlayer = null) {
  let seed = newSeed();
  let fresh = createInitialState({ seed });
  // A rematch keeps room seats bound to the same engine players. Because
  // the dealer cut is seeded, a nearby seed always gives us that same opener.
  while (hostPlayer !== null && fresh.turn !== hostPlayer) {
    seed = (seed + 1) | 0;
    fresh = createInitialState({ seed });
  }
  return fresh;
}

function initialHostPlayer(state) {
  return createInitialState({ seed: state.seed }).turn;
}

async function onlineGo() {
  if ($('opGo').disabled) return; // Enter key can't double-submit
  const name = opName.value.trim();
  if (!name) {
    opError.textContent = 'Every pegger needs a name.';
    opError.classList.remove('hidden');
    opName.focus();
    return;
  }
  const go = $('opGo');
  go.disabled = true;
  opError.classList.add('hidden');
  try {
    if (panelIntent === 'host') {
      const match = await OnlineMatch.create({
        game: GAME, name, state: freshOnlineState(), seats: 2,
      });
      closeOnlinePanel();
      openLobby(match);
    } else {
      const code = opCode.value.trim();
      if (code.length !== 4) {
        opError.textContent = 'The trail code is 4 letters.';
        opError.classList.remove('hidden');
        opCode.focus();
        return;
      }
      const match = await OnlineMatch.join({ game: GAME, code, name });
      closeOnlinePanel();
      enterOnlineGame(match, true);
    }
  } catch (err) {
    opError.textContent = friendlyRoomError(err);
    opError.classList.remove('hidden');
  } finally {
    go.disabled = false;
  }
}

function openLobby(match) {
  if (lobbyEl._match && lobbyEl._match !== match) lobbyEl._match.stop();
  lobbyCode.textContent = match.code;
  lobbyEl.classList.remove('hidden');
  match.start({
    onStatus: (status) => {
      if (status === 'playing') {
        lobbyEl.classList.add('hidden');
        enterOnlineGame(match, true);
      }
    },
    onError: () => {}, // the next poll normally settles a waiting-room hiccup
  });
  lobbyEl._match = match;
}

function cancelLobby() {
  const match = lobbyEl._match;
  if (match) match.leave();
  lobbyEl._match = null;
  lobbyEl.classList.add('hidden');
  refreshRejoin();
}

async function rejoinTable() {
  rejoinBtn.disabled = true;
  try {
    const match = await OnlineMatch.resume({ game: GAME });
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    // Only a room that's truly gone forfeits the session — a flaky
    // connection must not delete the one path back to the game.
    if (err && (err.code === 'not_found' || err.code === 'not_seated' || err.code === 'room_started')) {
      clearSession(GAME);
      refreshRejoin();
    }
  } finally {
    rejoinBtn.disabled = false;
  }
}

function refreshRejoin() {
  const saved = savedSession(GAME);
  rejoinBtn.classList.toggle('hidden', !saved);
  if (saved) rejoinBtn.textContent = `↩ REJOIN TABLE ${saved.code}`;
}

function enterOnlineGame(match, fresh = false) {
  clearTimeout(botTimer);
  clearTimeout(calloutTimer);
  selected = [];
  passSeat = null;
  busy = false;
  pendingDealSound = false;
  outcomeShown = false;
  sound.stop();
  resetEffects();
  pollErrors = 0;
  const hostPlayer = initialHostPlayer(match.state);
  const myPlayer = match.seat === 0 ? hostPlayer : 1 - hostPlayer;
  online = { match, myPlayer, hostPlayer, pushing: false };
  G = { mode: 'online', state: match.state };
  if (!BOARD.holes) buildBoard();
  show('game');
  if (fresh) sound.deal();
  render(fresh ? { dealAll: true } : { instantPegs: true });
  match.start({
    onState: onRemoteState,
    onStatus: onRemoteStatus,
    onPresence: onRemotePresence,
    onError: onPollError,
  });
  if (match.status === 'over') showGameOver(getStatus(G.state), { celebrate: false });
}

function stopPresentation() {
  clearTimeout(calloutTimer);
  eventQueue = [];
  afterQueue = null;
  busy = false;
  sound.stop();
  resetEffects();
  $('showPanel').classList.add('hidden');
  $('callout').classList.add('hidden');
}

function onRemoteState(newState) {
  if (!online || !G) return;
  const wasOver = getStatus(G.state).status === 'over';
  stopPresentation();
  selected = [];
  G.state = newState;
  const action = newState.lastAction?.type;
  const rematchDeal = wasOver && getStatus(newState).status === 'active' && !action;
  if (rematchDeal) {
    outcomeShown = false;
    show('game');
  }
  if (action === 'play') sound.slap();
  if (action === 'deal' || rematchDeal) sound.deal();
  render({
    slap: action === 'play',
    flipStarter: action === 'cut',
    dealAll: action === 'deal' || rematchDeal,
  });
  processEvents(newState.lastEvents || [], () => {
    render();
    const status = getStatus(G.state);
    if (status.status === 'over') showGameOver(status);
  });
}

function onRemoteStatus(status) {
  if (!online || status !== 'over') return;
  const engineStatus = getStatus(G.state);
  if (engineStatus.status === 'over') {
    if (!busy) showGameOver(engineStatus);
    return;
  }
  if (onlineOpponent().left) showOpponentLeft();
}

function onRemotePresence(opponents) {
  if (!online) return;
  pollErrors = 0;
  const opp = opponents[0];
  if (opp && opp.left && getStatus(G.state).status === 'active') {
    showOpponentLeft();
  } else if (!busy && screens.game.classList.contains('hidden') === false) {
    render();
  }
}

function showOpponentLeft() {
  stopPresentation();
  const opp = onlineOpponent();
  $('go-title').textContent = `${(opp.name || 'YOUR FRIEND').toUpperCase()} LEFT THE TRAIL`;
  $('go-line').textContent = 'The table is closed, but your pegs will be ready for another climb.';
  $('go-score').textContent = `${G.state.scores[0]} — ${G.state.scores[1]}`;
  $('againBtn').classList.add('hidden');
  show('gameover');
}

function onPollError(err) {
  if (!online) return;
  if (err && err.code === 'not_found') {
    online.match.stop();
    clearSession(GAME);
    online = null;
    G = null;
    finishMenu();
    return;
  }
  pollErrors++;
  if (pollErrors >= 3 && G && getStatus(G.state).status === 'active') {
    $('msg').textContent = 'CHOPPY CONNECTION — HANG TIGHT…';
  }
}

async function pushOnline() {
  if (!online || !G) return;
  const match = online.match;
  const attempted = G.state;
  const over = getStatus(attempted).status === 'over';
  online.pushing = true;
  try {
    await match.push(attempted, { over });
    pollErrors = 0;
    online.pushing = false;
    if (!busy) render();
  } catch (err) {
    if (!online || online.match !== match) return;
    if (err && err.code === 'version_conflict') {
      online.pushing = false;
      if (G.state !== match.state) onRemoteState(match.state);
      else if (!busy) render();
      return;
    }
    setTimeout(async () => {
      if (!online || online.match !== match) return;
      if (G.state !== attempted) {
        online.pushing = false;
        return;
      }
      try {
        await match.push(attempted, { over });
        pollErrors = 0;
        online.pushing = false;
        if (!busy) render();
      } catch (retryErr) {
        online.pushing = false;
        if (retryErr && retryErr.code === 'version_conflict') {
          if (G.state !== match.state) onRemoteState(match.state);
        } else {
          onPollError(retryErr);
          if (G.state !== match.state) onRemoteState(match.state);
          else if (!busy) render();
        }
      }
    }, 1500);
  }
}

async function onlineRematch() {
  if (!online || onlineOpponent().left) return;
  const match = online.match;
  const fresh = freshOnlineState(online.hostPlayer);
  stopPresentation();
  selected = [];
  outcomeShown = false;
  G.state = fresh;
  show('game');
  sound.deal();
  render({ dealAll: true });
  try {
    await match.push(fresh, {});
    render();
  } catch (err) {
    if (!online || online.match !== match) return;
    if (err && err.code === 'version_conflict') {
      if (G.state !== match.state) onRemoteState(match.state);
    } else {
      onPollError(err);
    }
  }
}

/* ---------------------------------------------------------------- boot */

finishMenu();
