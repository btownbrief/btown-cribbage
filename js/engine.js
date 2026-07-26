/* BTOWN CRIBBAGE engine — pure rules, no DOM, no timers, no Math.random.
 *
 * Every function here is a pure function over a plain JSON-serializable
 * state object. The shuffle and the cut use a seeded RNG whose state lives
 * INSIDE the game state, so a game can be JSON.stringify'd, parsed, and
 * resumed — and two states built from the same seed are identical. Online
 * multiplayer later = syncing this exact object. Keep ALL rule logic in
 * this file (show scoring lives in scoring.js, which this file imports —
 * nothing outside these two files knows a single rule).
 *
 * Public API:
 *   createInitialState(options) -> state
 *   legalMoves(state)           -> array of move objects for state.turn
 *   applyMove(state, move)      -> NEW state (never mutates)
 *   getStatus(state)            -> { status, winner, skunk, scores }
 *
 * Cards are 2-char strings: rank + suit, e.g. "5H", "TS" (T = ten).
 * Two players, 0 and 1. Race to 121; the game ends the INSTANT a player
 * pegs point 121, even mid-count — remaining counts never happen.
 *
 * Phases and their moves:
 *   'discard'  both players put 2 in the crib   { type:'discard', cards:[a,b] }
 *   'cut'      non-dealer cuts the starter      { type:'cut' }
 *   'play'     the pegging play                 { type:'play', card } | { type:'go' }
 *   'show'     counting, one hand per move      { type:'count' }
 *   'handDone' hand summary shown               { type:'deal' }
 *   'over'     someone hit 121                  (no moves)
 *
 * Every applyMove sets state.lastEvents — an array of scoring events
 * ({ kind, player, points, label, ... }) for the UI to announce. The
 * engine names them ("fifteen for two", "his nobs") because the names ARE
 * the rules; the UI just displays them.
 */

import {
  scoreHand, rankOf, suitOf, valueOf, runIndex, rankName,
} from './scoring.js';

export { scoreHand, rankOf, suitOf, valueOf, runIndex };

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const WIN_SCORE = 121;
export const SKUNK_LINE = 91;

/* ---------------------------------------------------------------- RNG
 * mulberry32 — tiny, deterministic. The integer state is threaded through
 * and stored on the game state as `rng`. */

function rngNext(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, s };
}

/* Fisher-Yates. Returns { deck, rng } — never touches the input array. */
function shuffle(cards, rngState) {
  const deck = cards.slice();
  let s = rngState;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = rngNext(s);
    s = r.s;
    const j = Math.floor(r.value * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return { deck, rng: s };
}

function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

/* ---------------------------------------------------------------- setup */

export function createInitialState(options = {}) {
  const seed = (options.seed ?? 1) | 0;
  let rng = seed;

  let dealer = options.dealer;
  if (dealer !== 0 && dealer !== 1) {
    // cut for deal — low card deals, folded into one coin flip off the seed
    const r = rngNext(rng);
    rng = r.s;
    dealer = r.value < 0.5 ? 0 : 1;
  }

  const state = {
    version: 1,
    seed,
    rng,
    dealer,
    scores: [0, 0],
    prevScores: [0, 0], // back-peg positions, for the board UI
    handNumber: 0,
    phase: 'discard',
    turn: 0,
    hands: [[], []],
    showHands: [[], []], // the kept 4, frozen when the crib is complete
    crib: [],
    deck: [],
    starter: null,
    play: null,
    showStep: 0,
    winner: null,
    skunk: false,
    lastAction: null,
    lastEvents: [],
  };
  dealInto(state);
  return state;
}

/* Deal 6 cards each from a fresh shuffled deck. Mutates the draft state —
 * only ever called on a clone inside this module. */
function dealInto(s) {
  const shuffled = shuffle(freshDeck(), s.rng);
  s.rng = shuffled.rng;
  const deck = shuffled.deck;
  s.handNumber += 1;
  s.hands = [deck.slice(0, 6), deck.slice(6, 12)];
  s.deck = deck.slice(12);
  s.showHands = [[], []];
  s.crib = [];
  s.starter = null;
  s.play = null;
  s.showStep = 0;
  s.phase = 'discard';
  s.turn = 1 - s.dealer; // pone discards first (order doesn't matter)
}

/* ------------------------------------------------------- pegging scorer
 * Scores the card just played (the last card of `pile`) given the running
 * count AFTER it. Fifteens, pairs (consecutive same-rank only), and runs
 * hiding in the most recent cards. Exported for the UI/bot to preview. */

export function scorePegging(pile, count) {
  const items = [];
  const cards = pile.map((entry) => entry.card);
  const n = cards.length;

  if (count === 15) {
    items.push({ kind: 'fifteen', points: 2, label: 'fifteen for two' });
  }

  // pairs: how many cards at the tail share the last card's rank
  const rank = rankOf(cards[n - 1]);
  let same = 1;
  while (same < n && rankOf(cards[n - 1 - same]) === rank) same++;
  if (same === 2) {
    items.push({ kind: 'pair', points: 2, label: `pair of ${rankName(cards[n - 1])}s` });
  } else if (same === 3) {
    items.push({ kind: 'pair', points: 6, label: 'pairs royal' });
  } else if (same >= 4) {
    items.push({ kind: 'pair', points: 12, label: 'double pairs royal' });
  }

  // runs: longest tail of 3+ distinct consecutive ranks, any order
  for (let len = Math.min(n, 7); len >= 3; len--) {
    const tail = cards.slice(n - len).map(runIndex).sort((a, b) => a - b);
    let isRun = true;
    for (let i = 1; i < tail.length; i++) {
      if (tail[i] !== tail[i - 1] + 1) { isRun = false; break; }
    }
    if (isRun) {
      items.push({ kind: 'run', points: len, label: `run of ${len}` });
      break;
    }
  }

  return items;
}

/* ---------------------------------------------------------------- moves */

export function legalMoves(state) {
  if (state.phase === 'over') return [];
  const p = state.turn;

  switch (state.phase) {
    case 'discard': {
      const hand = state.hands[p];
      const moves = [];
      for (let i = 0; i < hand.length; i++) {
        for (let j = i + 1; j < hand.length; j++) {
          moves.push({ type: 'discard', cards: [hand[i], hand[j]] });
        }
      }
      return moves;
    }
    case 'cut':
      return [{ type: 'cut' }];
    case 'play': {
      const playable = state.hands[p]
        .filter((card) => state.play.count + valueOf(card) <= 31)
        .map((card) => ({ type: 'play', card }));
      return playable.length > 0 ? playable : [{ type: 'go' }];
    }
    case 'show':
      return [{ type: 'count' }];
    case 'handDone':
      return [{ type: 'deal' }];
    default:
      return [];
  }
}

function sameMove(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'play') return a.card === b.card;
  if (a.type === 'discard') {
    const setA = [...a.cards].sort().join();
    const setB = [...b.cards].sort().join();
    return setA === setB;
  }
  return true;
}

export function applyMove(state, move) {
  const legal = legalMoves(state);
  if (!move || !legal.some((m) => sameMove(m, move))) {
    throw new Error('Illegal move: ' + JSON.stringify(move));
  }

  // deep clone (the state is JSON-serializable by contract), then mutate
  // the clone freely — the input state is never touched
  const s = JSON.parse(JSON.stringify(state));
  s.lastEvents = [];
  s.lastAction = { player: s.turn, type: move.type };

  switch (move.type) {
    case 'discard': applyDiscard(s, move); break;
    case 'cut': applyCut(s); break;
    case 'play': applyPlay(s, move); break;
    case 'go': applyGo(s); break;
    case 'count': applyCount(s); break;
    case 'deal': s.dealer = 1 - s.dealer; dealInto(s); break;
  }
  return s;
}

/* Move a player's pegs. Returns true if that won the game — every caller
 * must stop the world immediately when it does. */
function peg(s, player, points, events) {
  if (points > 0) {
    s.prevScores[player] = s.scores[player];
    s.scores[player] = Math.min(WIN_SCORE, s.scores[player] + points);
  }
  s.lastEvents.push(...events);
  if (s.scores[player] >= WIN_SCORE) {
    s.winner = player;
    s.skunk = s.scores[1 - player] < SKUNK_LINE;
    s.phase = 'over';
    s.lastEvents.push({
      kind: 'win', player, points: 0,
      label: s.skunk ? 'skunked' : 'game',
    });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------- discard */

function applyDiscard(s, move) {
  const p = s.turn;
  s.hands[p] = s.hands[p].filter((card) => !move.cards.includes(card));
  s.crib.push(...move.cards);
  s.lastAction.count = move.cards.length;

  const other = 1 - p;
  if (s.hands[other].length > 4) {
    s.turn = other;
    return;
  }
  // crib complete — freeze the show hands, on to the cut
  s.showHands = [s.hands[0].slice(), s.hands[1].slice()];
  s.phase = 'cut';
  s.turn = 1 - s.dealer; // non-dealer cuts
}

/* ----------------------------------------------------------------- cut */

function applyCut(s) {
  const r = rngNext(s.rng);
  s.rng = r.s;
  const idx = Math.floor(r.value * s.deck.length);
  s.starter = s.deck[idx];
  s.deck = s.deck.slice(0, idx).concat(s.deck.slice(idx + 1));
  s.lastAction.card = s.starter;

  if (rankOf(s.starter) === 'J') {
    // his heels — dealer pegs 2 the moment the Jack turns over
    const won = peg(s, s.dealer, 2, [
      { kind: 'heels', player: s.dealer, points: 2, label: 'his heels' },
    ]);
    if (won) return;
  }
  s.phase = 'play';
  s.turn = 1 - s.dealer; // non-dealer leads
  s.play = { count: 0, pile: [], prevPiles: [], goSaid: [false, false] };
}

/* ---------------------------------------------------------------- play */

function hasPlayable(s, player) {
  return s.hands[player].some((card) => s.play.count + valueOf(card) <= 31);
}

/* End the current 31/go sequence: archive the pile, reset the count, and
 * hand the next lead to the opponent of whoever played last (or whoever
 * still has cards). If everyone is out of cards, the play is over. */
function endSequence(s, lastPlayer) {
  s.play.prevPiles.push(s.play.pile);
  s.play.pile = [];
  s.play.count = 0;
  s.play.goSaid = [false, false];

  const opponent = 1 - lastPlayer;
  if (s.hands[0].length === 0 && s.hands[1].length === 0) {
    startShow(s);
  } else if (s.hands[opponent].length > 0) {
    s.turn = opponent;
  } else {
    s.turn = lastPlayer;
  }
}

function applyPlay(s, move) {
  const p = s.turn;
  s.hands[p] = s.hands[p].filter((card) => card !== move.card);
  s.play.pile.push({ card: move.card, player: p });
  s.play.count += valueOf(move.card);
  s.lastAction.card = move.card;
  s.lastAction.count = s.play.count;

  const items = scorePegging(s.play.pile, s.play.count);
  if (s.play.count === 31) {
    items.push({ kind: 'thirtyone', points: 2, label: 'thirty-one for two' });
  }
  const events = items.map((item) => ({ ...item, player: p }));
  const points = items.reduce((sum, item) => sum + item.points, 0);
  if (peg(s, p, points, events)) return;

  if (s.play.count === 31) {
    // 31's two points include the last card — sequence over, no extra
    endSequence(s, p);
    return;
  }

  const q = 1 - p;
  if (s.hands[q].length > 0 && !s.play.goSaid[q]) {
    s.turn = q; // their turn — to play, or to say go
  } else if (hasPlayable(s, p)) {
    s.turn = p; // opponent is out or said go: keep playing what fits
  } else {
    // nobody can add a card — one point for the last card played
    const allOut = s.hands[0].length === 0 && s.hands[1].length === 0;
    const won = peg(s, p, 1, [{
      kind: allOut ? 'lastcard' : 'go',
      player: p, points: 1,
      label: allOut ? 'one for last card' : 'one for the go',
    }]);
    if (won) return;
    endSequence(s, p);
  }
}

function applyGo(s) {
  const p = s.turn;
  s.play.goSaid[p] = true;

  const q = 1 - p;
  if (hasPlayable(s, q)) {
    s.turn = q; // opponent plays out everything they can
    return;
  }
  // opponent can't add either — last card played takes the go point
  const last = s.play.pile[s.play.pile.length - 1];
  const won = peg(s, last.player, 1, [{
    kind: 'go', player: last.player, points: 1, label: 'one for the go',
  }]);
  if (won) return;
  endSequence(s, last.player);
}

/* ---------------------------------------------------------------- show
 * Strict order, one hand per 'count' move: non-dealer's hand, dealer's
 * hand, then the crib. The instant-121 rule makes this order decisive —
 * if the non-dealer's count reaches 121, the dealer's never happens. */

function startShow(s) {
  s.phase = 'show';
  s.showStep = 0;
  s.turn = 1 - s.dealer;
}

function applyCount(s) {
  const pone = 1 - s.dealer;
  const step = s.showStep;

  let player;
  let role;
  let cards;
  if (step === 0) { player = pone; role = 'hand'; cards = s.showHands[pone]; }
  else if (step === 1) { player = s.dealer; role = 'hand'; cards = s.showHands[s.dealer]; }
  else { player = s.dealer; role = 'crib'; cards = s.crib; }

  const breakdown = scoreHand(cards, s.starter, { isCrib: role === 'crib' });
  const won = peg(s, player, breakdown.total, [{
    kind: 'show', player, role, points: breakdown.total,
    cards: cards.slice(), starter: s.starter, breakdown,
    label: role === 'crib' ? 'the crib' : 'the hand',
  }]);
  if (won) return;

  s.showStep += 1;
  if (s.showStep > 2) {
    s.phase = 'handDone';
    s.turn = 1 - s.dealer; // next hand's dealer taps the deal
  } else {
    s.turn = s.dealer; // steps 1 and 2 are both the dealer's counts
  }
}

/* ---------------------------------------------------------------- status */

export function getStatus(state) {
  if (state.phase === 'over') {
    return {
      status: 'over',
      winner: state.winner,
      skunk: state.skunk,
      scores: state.scores.slice(),
    };
  }
  return { status: 'active', winner: null, skunk: false, scores: state.scores.slice() };
}
