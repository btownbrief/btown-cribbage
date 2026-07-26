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

const SAVE_KEY = 'btown-cribbage-save-v1';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is Champ

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_CHAR = { T: '10' };
const RANK_SORT = 'A23456789TJQK';

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };

let G = null;             // { mode: 'bot' | 'pass', state }
let selected = [];        // discard picks (card strings)
let passSeat = null;      // pass & play: whose hand is currently revealed
let botTimer = null;
let calloutTimer = null;
let eventQueue = [];      // scoring events waiting to be announced
let afterQueue = null;    // continuation once the queue drains
let busy = false;         // ignore taps while callouts/panels are running

/* ---------------------------------------------------------------- helpers */

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isRed = (card) => suitOf(card) === 'H' || suitOf(card) === 'D';
const rankChar = (card) => RANK_CHAR[rankOf(card)] || rankOf(card);
const cardText = (card) => rankChar(card) + SUIT_CHAR[suitOf(card)];

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'Champ' : 'You';
  return 'Player ' + (p + 1);
}
function playerNameS(p) { // possessive-friendly subject ("Your" / "Champ's")
  if (G.mode === 'bot') return p === BOT ? "Champ's" : 'Your';
  return 'Player ' + (p + 1) + "'s";
}

function humanTurn() {
  return G && getStatus(G.state).status === 'active' &&
    !(G.mode === 'bot' && G.state.turn === BOT);
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

function save() {
  try {
    if (G && getStatus(G.state).status === 'active') {
      localStorage.setItem(SAVE_KEY, JSON.stringify(G));
    } else {
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

  // player chips
  const chips = $('players');
  chips.innerHTML = '';
  for (const p of [0, 1]) {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (status.status === 'active' && s.turn === p ? ' active' : '');
    chip.innerHTML =
      `<span class="dot p${p}"></span>` +
      `<span>${G.mode === 'bot' && p === BOT ? '🐉 Champ' : playerName(p)}</span>` +
      (s.dealer === p ? '<span class="crib-tag" title="Their crib">🧺</span>' : '') +
      `<span class="score">${s.scores[p]}</span>`;
    chips.appendChild(chip);
  }

  updatePegs();

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
  $('countBtn').classList.toggle('hidden', !(s.phase === 'show' && !busy));
  if (s.phase === 'show') {
    const pone = 1 - s.dealer;
    const who = s.showStep === 0 ? playerNameS(pone) : playerNameS(s.dealer);
    $('countBtn').textContent = s.showStep === 2
      ? `🔢 COUNT ${playerNameS(s.dealer).toUpperCase()} CRIB`
      : `🔢 COUNT ${who.toUpperCase()} HAND`;
  }
  $('dealBtn').classList.toggle('hidden', !(s.phase === 'handDone' && !busy));
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
  let owner = G.mode === 'bot' ? 0 : s.turn;
  let revealed = true;
  if (G.mode === 'pass') {
    if (s.phase === 'cut' || s.phase === 'show' || s.phase === 'handDone') revealed = false;
    else revealed = passSeat === s.turn;
  }
  if (s.phase === 'show' || s.phase === 'handDone') {
    // cards are on the table; show the kept hand face-up for reference
    if (G.mode === 'bot') {
      $('handLabel').textContent = 'your hand (counted with the starter)';
      for (const card of sortedHand(s.showHands[0])) handEl.appendChild(cardEl(card));
    } else {
      $('handLabel').textContent = '';
    }
    return;
  }

  $('handLabel').textContent = G.mode === 'bot'
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
      const cribWho = s.dealer === (G.mode === 'bot' ? 0 : s.turn)
        ? "It's your crib — a little generosity pays."
        : (G.mode === 'bot' ? "Champ's crib — don't feed the monster." : "Their crib — toss them table scraps.");
      line = myTurn
        ? `Pick 2 cards to toss. ${cribWho}`
        : 'Champ is picking his toss…';
      break;
    }
    case 'cut':
      line = myTurn
        ? 'Tap the deck to cut the starter card.'
        : 'Champ reaches over to cut…';
      break;
    case 'play':
      if (myTurn) {
        const onlyGo = moves.length === 1 && moves[0].type === 'go';
        line = onlyGo
          ? "Nothing fits under 31 — say go."
          : `${G.mode === 'pass' ? playerName(s.turn) + ': play' : 'Play'} a card. 15s, pairs and runs peg points.`;
      } else {
        line = 'Champ studies his cards…';
      }
      break;
    case 'show': {
      const pone = 1 - s.dealer;
      line = s.showStep === 0
        ? `Time to count. ${playerNameS(pone)} hand goes first — them's the rules.`
        : (s.showStep === 1 ? `Now ${playerNameS(s.dealer).toLowerCase()} hand.` : `And ${playerNameS(s.dealer).toLowerCase()} crib to finish.`);
      break;
    }
    case 'handDone':
      line = `Hand ${s.handNumber} in the books. The deal passes on.`;
      break;
  }
  $('msg').textContent = line;
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
  eventQueue = events.filter((e) => e.kind !== 'win');
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
  co.className = e.player === 1 ? 'for-p1' : '';
  co.innerHTML = `<span class="co-label">${text}</span>` +
    (e.points ? `<span class="co-pts">+${e.points} for ${playerName(e.player)}</span>` : '');
  co.classList.remove('hidden');
  co.style.animation = 'none'; void co.offsetWidth; co.style.animation = '';
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(nextEvent, 1050);
}

/* --------------------------------------------------------- the show panel */

function openShowPanel(e) {
  $('showTitle').textContent =
    `${playerNameS(e.player)} ${e.role === 'crib' ? 'crib' : 'hand'} — ${e.points} point${e.points === 1 ? '' : 's'}`;

  const cardsRow = $('showCards');
  cardsRow.innerHTML = '';
  for (const card of sortedHand(e.cards)) cardsRow.appendChild(cardEl(card));
  const starterEl = cardEl(e.starter);
  starterEl.classList.add('starter-card');
  starterEl.title = 'the starter';
  cardsRow.appendChild(starterEl);

  const list = $('showItems');
  list.innerHTML = '';
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
    list.appendChild(div);
  });
  $('showTotal').innerHTML = `TOTAL — <b>${e.points}</b>`;
  $('showTotal').style.animationDelay = (e.breakdown.items.length * 90 + 120) + 'ms';
  $('showPanel').classList.remove('hidden');
}

$('showNextBtn').addEventListener('click', () => {
  $('showPanel').classList.add('hidden');
  nextEvent();
});

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  clearTimeout(botTimer);
  G.state = applyMove(G.state, move);
  save();

  const fx = {};
  if (move.type === 'play') fx.slap = true;
  if (move.type === 'cut') fx.flipStarter = true;
  if (move.type === 'deal') fx.dealAll = true;
  if (move.type === 'discard') selected = [];
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
  // pass & play: interstitial before revealing a different player's cards
  if (['discard', 'play'].includes(s.phase) && passSeat !== s.turn) {
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
  doMove({ type: 'count' });
});

$('dealBtn').addEventListener('click', () => {
  if (busy || !G || G.state.phase !== 'handDone') return;
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
  G = { mode, state: createInitialState({ seed: newSeed() }) };
  save();
  if (!BOARD.holes) buildBoard();
  if (mode === 'pass') {
    showHandoff(G.state.turn);
  } else {
    show('game');
    render({ dealAll: true });
    scheduleNext(null);
  }
}

function showHandoff(player) {
  passSeat = null;
  $('handoffTitle').textContent = 'Pass the phone to ' + playerName(player);
  show('handoff');
}

$('handoffBtn').addEventListener('click', () => {
  passSeat = G.state.turn;
  show('game');
  render({ dealAll: true });
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

function showGameOver(status) {
  clearTimeout(botTimer);
  save(); // clears the save — game's done
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
  } else {
    $('go-title').textContent = playerName(winner).toUpperCase() + ' SUMMITS! ⛰️';
    line.textContent = status.skunk ? pick(SKUNK_LINES) : pick(WIN_LINES);
  }
  $('go-score').textContent = `${status.scores[0]} — ${status.scores[1]}`;
  show('gameover');
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
  if (!BOARD.holes) buildBoard();
  if (G.mode === 'pass' && ['discard', 'play'].includes(G.state.phase)) {
    showHandoff(G.state.turn);
  } else {
    show('game');
    render({ dealAll: true });
    scheduleNext(null);
  }
});

function goMenu() {
  clearTimeout(botTimer);
  clearTimeout(calloutTimer);
  busy = false;
  $('showPanel').classList.add('hidden');
  $('callout').classList.add('hidden');
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  show('menu');
}

$('homeBtn').addEventListener('click', goMenu);
$('menuBtn').addEventListener('click', goMenu);
$('againBtn').addEventListener('click', () => startGame(G.mode));

/* ---------------------------------------------------------------- boot */

goMenu();
