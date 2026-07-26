/* Engine test — plain Node, no framework. Run: node scripts/test-engine.mjs
 * Exercises the pure engine only; nothing here touches the DOM.
 * Covers his heels, the pegging play (15s, pairs royal, runs, go/31,
 * count resets, last card), the strict show order, dealer alternation,
 * instant win at 121, serialization, and a full bot-vs-bot soak. */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, valueOf, WIN_SCORE,
} from '../js/engine.js';
import { chooseMove } from '../js/bot.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

/* Build a hand-crafted state (JSON-serializable, like the real thing) so
 * exact rules can be tested without hunting for a seed. Player 1 deals,
 * player 0 is the pone, unless overridden. */
function fixture(overrides = {}) {
  const base = createInitialState({ seed: 42, dealer: 1 });
  return { ...base, ...overrides };
}

function playFixture(overrides = {}) {
  return fixture({
    phase: 'play',
    turn: 0, // pone leads
    starter: '3D',
    crib: ['2C', '2D', '3C', '4C'],
    play: { count: 0, pile: [], prevPiles: [], goSaid: [false, false] },
    deck: [],
    ...overrides,
  });
}

const eventKinds = (s) => s.lastEvents.map((e) => e.kind).join(',');

/* ---------------------------------------------------------- determinism */
{
  const a = createInitialState({ seed: 12345 });
  const b = createInitialState({ seed: 12345 });
  const c = createInitialState({ seed: 54321 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'same seed -> identical deal');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seed -> different deal');
  assert(a.hands[0].length === 6 && a.hands[1].length === 6, 'six cards each');
  const all = [...a.hands[0], ...a.hands[1], ...a.deck];
  assert(all.length === 52 && new Set(all).size === 52, 'full 52-card deck accounted for');
  assert(a.phase === 'discard' && a.scores[0] === 0 && a.scores[1] === 0, 'game opens on the discard');
}

/* ------------------------------------------------------------- discard */
{
  let s = fixture();
  assert(legalMoves(s).length === 15, '15 ways to toss 2 of 6');
  assert(s.turn === 0, 'pone (player 0) discards first when player 1 deals');
  const first = s.hands[0].slice(0, 2);
  s = applyMove(s, { type: 'discard', cards: first });
  assert(s.hands[0].length === 4 && s.crib.length === 2, 'first discard: 4 kept, 2 in the crib');
  assert(s.turn === 1 && s.phase === 'discard', 'dealer discards next');
  s = applyMove(s, { type: 'discard', cards: [s.hands[1][5 - 5], s.hands[1][1]] });
  assert(s.crib.length === 4 && s.phase === 'cut', 'crib complete -> the cut');
  assert(s.turn === 0, 'non-dealer cuts');
  assert(s.showHands[0].length === 4 && s.showHands[1].length === 4, 'show hands frozen at 4');
  // discard order-insensitive matching
  let t = fixture();
  const pair = [t.hands[0][2], t.hands[0][0]];
  t = applyMove(t, { type: 'discard', cards: pair });
  assert(t.crib.length === 2, 'discard accepts cards in either order');
}

/* ------------------------------------------------------------ his heels */
{
  let s = fixture({
    phase: 'cut', turn: 0,
    hands: [['AH', '2H', '3H', '4H'], ['9S', '9D', 'KS', 'KD']],
    showHands: [['AH', '2H', '3H', '4H'], ['9S', '9D', 'KS', 'KD']],
    crib: ['6C', '7C', '8C', '9C'],
    deck: ['JH'], // the cut can only find a Jack
  });
  s = applyMove(s, { type: 'cut' });
  assert(s.starter === 'JH', 'starter cut from the deck');
  assert(s.scores[1] === 2 && s.scores[0] === 0, 'his heels: dealer pegs 2 on a Jack starter');
  assert(eventKinds(s).includes('heels'), 'heels event announced');
  assert(s.phase === 'play' && s.turn === 0, 'play begins, non-dealer leads');

  // heels at 119 wins the game right at the cut
  let w = fixture({
    phase: 'cut', turn: 0, scores: [50, 119],
    hands: [['AH', '2H', '3H', '4H'], ['9S', '9D', 'KS', 'KD']],
    showHands: [['AH', '2H', '3H', '4H'], ['9S', '9D', 'KS', 'KD']],
    crib: ['6C', '7C', '8C', '9C'],
    deck: ['JH'],
  });
  w = applyMove(w, { type: 'cut' });
  const st = getStatus(w);
  assert(st.status === 'over' && st.winner === 1, 'heels can win the game at the cut');
  assert(w.scores[1] === WIN_SCORE, 'winning score pegs out at exactly 121');

  // a non-Jack cut pegs nothing
  let n = fixture({
    phase: 'cut', turn: 0,
    hands: [['AH', '2H', '3H', '4H'], ['9S', '9D', 'KS', 'KD']],
    showHands: [['AH', '2H', '3H', '4H'], ['9S', '9D', 'KS', 'KD']],
    crib: ['6C', '7C', '8C', '9C'],
    deck: ['QH'],
  });
  n = applyMove(n, { type: 'cut' });
  assert(n.scores[0] === 0 && n.scores[1] === 0, 'no heels on a queen');
}

/* ------------------------------------- the play: 15, runs, go, 31, reset */
{
  let s = playFixture({
    hands: [['7H', '6S', 'KD'], ['8D', '9C', 'AC']],
    showHands: [['7H', '6S', 'KD', '2H'], ['8D', '9C', 'AC', '3H']],
  });

  s = applyMove(s, { type: 'play', card: '7H' }); // count 7
  assert(s.play.count === 7 && s.turn === 1, 'count runs up, turns alternate');

  s = applyMove(s, { type: 'play', card: '8D' }); // count 15!
  assert(s.scores[1] === 2 && eventKinds(s) === 'fifteen', 'fifteen during the play pegs 2');

  s = applyMove(s, { type: 'play', card: '6S' }); // count 21, pile 7-8-6
  assert(s.scores[0] === 3 && eventKinds(s) === 'run', 'out-of-order 7-8-6 is a run of 3');

  s = applyMove(s, { type: 'play', card: '9C' }); // count 30, pile 7-8-6-9
  assert(s.scores[1] === 6, '6-9 extends it: run of 4 pegs 4');

  // player 0 holds only a King: 30 + 10 busts — must say go
  const mustGo = legalMoves(s);
  assert(mustGo.length === 1 && mustGo[0].type === 'go', 'no card fits under 31 -> only GO is legal');
  s = applyMove(s, { type: 'go' });
  assert(s.turn === 1 && s.play.goSaid[0], 'after the go, opponent plays on');

  s = applyMove(s, { type: 'play', card: 'AC' }); // count 31 exactly
  assert(s.scores[1] === 8 && eventKinds(s) === 'thirtyone', '31 on the nose pegs 2 (not 2+1)');
  assert(s.play.count === 0 && s.play.pile.length === 0, 'count resets after 31');
  assert(s.play.prevPiles.length === 1 && s.play.prevPiles[0].length === 5, 'spent pile archived');
  assert(s.turn === 0, 'fresh count: lead passes across the table');

  s = applyMove(s, { type: 'play', card: 'KD' }); // last card of the whole play
  assert(s.scores[0] === 4 && eventKinds(s) === 'lastcard', 'one for last card');
  assert(s.phase === 'show', 'cards exhausted -> the show');
}

/* -------------------------------------------- pairs royal in the play */
{
  let s = playFixture({
    hands: [['5H', '5S', 'KD'], ['5C', '5D', 'KS']],
    showHands: [['5H', '5S', 'KD', '2H'], ['5C', '5D', 'KS', '3H']],
  });
  s = applyMove(s, { type: 'play', card: '5H' }); // 5
  s = applyMove(s, { type: 'play', card: '5C' }); // 10 - pair
  assert(s.scores[1] === 2 && eventKinds(s) === 'pair', 'second 5 pegs a pair');
  s = applyMove(s, { type: 'play', card: '5S' }); // 15 - fifteen AND pairs royal
  assert(s.scores[0] === 8 && eventKinds(s) === 'fifteen,pair', 'third 5: fifteen for 2 + pairs royal for 6');
  s = applyMove(s, { type: 'play', card: '5D' }); // 20 - double pairs royal
  assert(s.scores[1] === 14, 'fourth 5: double pairs royal for 12');
  assert(s.lastEvents.some((e) => e.kind === 'pair' && e.points === 12), '12-point event announced');
}

/* ------------------------------- go point mid-play, count reset, leads */
{
  let s = playFixture({
    hands: [['9H', '8H', '2C'], ['KS', 'KD']],
    showHands: [['9H', '8H', '2C', 'AD'], ['KS', 'KD', 'QH', 'JC']],
  });
  s = applyMove(s, { type: 'play', card: '9H' });  // 9
  s = applyMove(s, { type: 'play', card: 'KS' });  // 19
  s = applyMove(s, { type: 'play', card: '8H' });  // 27
  s = applyMove(s, { type: 'go' });                 // p1's kings don't fit
  assert(s.turn === 0, 'opponent keeps playing after a go');
  s = applyMove(s, { type: 'play', card: '2C' });  // 29 - now p0 is dry too
  assert(s.scores[0] === 1 && eventKinds(s) === 'go', 'go point: 1 to the last card under 31');
  assert(s.play.count === 0 && s.play.goSaid[0] === false && s.play.goSaid[1] === false,
    'count and go flags reset for the new sequence');
  assert(s.turn === 1, 'player who did not play the last card leads next');
  s = applyMove(s, { type: 'play', card: 'KD' }); // p1's final card, count 10
  assert(s.phase === 'show', 'both hands empty -> the show');
  assert(s.scores[1] === 1 && s.lastEvents.some((e) => e.kind === 'lastcard'),
    'very last card of the play pegs 1');
}

/* --------------------- both players stuck with cards: go point, new count */
{
  let s = playFixture({
    hands: [['KH', 'KC', 'QS'], ['QD', 'JD', 'TS']],
    showHands: [['KH', 'KC', 'QS', '2H'], ['QD', 'JD', 'TS', '3H']],
  });
  s = applyMove(s, { type: 'play', card: 'KH' }); // 10
  s = applyMove(s, { type: 'play', card: 'QD' }); // 20
  s = applyMove(s, { type: 'play', card: 'KC' }); // 30
  assert(legalMoves(s).length === 1 && legalMoves(s)[0].type === 'go', 'p1 must go at 30');
  s = applyMove(s, { type: 'go' });
  // p0 can't add either (QS busts): engine awards the go to p0's K instantly
  assert(s.scores[0] === 1 && s.lastEvents.some((e) => e.kind === 'go' && e.player === 0),
    'both stuck: last card played takes the go point');
  assert(s.play.count === 0 && s.turn === 1, 'new sequence, other side leads');
}

/* ------------------------------------------- instant win during pegging */
{
  let s = playFixture({
    scores: [120, 118],
    hands: [['7H', '2C'], ['8D', '9C']],
    showHands: [['7H', '2C', 'KD', 'KH'], ['8D', '9C', 'QS', 'QD']],
  });
  s = applyMove(s, { type: 'play', card: '7H' });
  s = applyMove(s, { type: 'play', card: '8D' }); // fifteen -> 118+2 = 120, no win
  assert(getStatus(s).status === 'active', '120 is not out');
  s = applyMove(s, { type: 'play', card: '2C' }); // 17, no points
  s = applyMove(s, { type: 'play', card: '9C' }); // 26, no points... play on
  // p0's turn - nothing fits? 26+7? p0 has nothing left. Sequence ended, last card p1 pegs 1 -> 121!
  const st = getStatus(s);
  assert(st.status === 'over' && st.winner === 1, 'a single go point can win the game');
  assert(s.scores[1] === WIN_SCORE && s.phase === 'over', 'pegged out at 121, game frozen');
  assert(legalMoves(s).length === 0, 'no legal moves after the game ends');
}

/* -------------------------------------- the show: strict counting order */
{
  const showFixture = (scores) => fixture({
    phase: 'show', showStep: 0, turn: 0, scores, prevScores: scores.slice(),
    hands: [[], []],
    // pone (p0): 4456 + 5 starter is a monster; dealer (p1) holds a decent hand
    showHands: [['4H', '4C', '5D', '6S'], ['7H', '8C', '9D', 'JS']],
    crib: ['2C', '3C', 'QH', 'KD'],
    starter: '5S',
    play: { count: 0, pile: [], prevPiles: [], goSaid: [false, false] },
    deck: [],
  });

  // Normal order: pone, dealer, crib - with the right totals.
  let s = showFixture([0, 0]);
  s = applyMove(s, { type: 'count' });
  // 4455+6... here: 4,4,5,6 + 5: fifteens {4,5,6}x4=8, {5,5,4,A?}no, {5,5,...}? 5+5+4=14, 5+5+... wait
  // 4H 4C 5D 6S + 5S: fifteens: {4,5,6} four ways (two 4s x two 5s) = 8; {4,4,5,..}? 13; {5,5,..}? 10;
  // {6,5,4} counted; {6,4,5} same. Pairs: 4,4 and 5,5 = 4. Runs: 4-5-6 four ways = 12. Total 24.
  assert(s.lastEvents[0].kind === 'show' && s.lastEvents[0].player === 0 && s.lastEvents[0].role === 'hand',
    'non-dealer counts first');
  assert(s.scores[0] === 24, 'pone hand counted right (24)');
  s = applyMove(s, { type: 'count' });
  // 7,8,9,J + 5: fifteens {7,8},{J,5} = 4; run 7-8-9 = 3; nobs JS vs 5S = 1. Total 8.
  assert(s.lastEvents[0].player === 1 && s.scores[1] === 8, 'dealer hand counted second (8, incl. nobs)');
  s = applyMove(s, { type: 'count' });
  // crib 2,3,Q,K + 5: fifteens {2,3,Q},{2,3,K},{Q,5},{K,5} = 8. Total 8.
  assert(s.lastEvents[0].role === 'crib' && s.scores[1] === 16, 'crib counted last, to the dealer');
  assert(s.phase === 'handDone', 'hand wrapped after the crib');

  // THE decisive case: both sides would cross 121 this hand - the pone's
  // count comes first, so the pone wins and the dealer never counts.
  let d = showFixture([100, 118]);
  d = applyMove(d, { type: 'count' });
  const st = getStatus(d);
  assert(st.status === 'over' && st.winner === 0, 'both would cross 121: non-dealer counts out first');
  assert(d.scores[1] === 118, "dealer's monster hand never gets counted");
  assert(legalMoves(d).length === 0, 'the show stops the instant the game is won');

  // Dealer can also win in the show if the pone falls short.
  let e = showFixture([90, 118]);
  e = applyMove(e, { type: 'count' }); // pone -> 114, short of 121
  assert(getStatus(e).status === 'active', 'pone at 114: game still on');
  e = applyMove(e, { type: 'count' }); // dealer 118+6 = 124 -> out
  assert(getStatus(e).winner === 1, 'dealer counts out in the show');

  // Skunk: winner at 121 while the loser is under 91.
  let k = showFixture([118, 60]);
  k = applyMove(k, { type: 'count' });
  assert(getStatus(k).skunk === true, 'winning before the loser reaches 91 is a skunk');
  const noSkunk = getStatus(d);
  assert(noSkunk.skunk === false, '118 across the table is no skunk');
}

/* --------------------------------------------------- dealer alternation */
{
  let s = fixture({ phase: 'handDone', turn: 0 });
  const before = s.dealer;
  const handBefore = s.handNumber;
  s = applyMove(s, { type: 'deal' });
  assert(s.dealer === 1 - before, 'deal alternates each hand');
  assert(s.handNumber === handBefore + 1, 'hand counter ticks');
  assert(s.phase === 'discard' && s.hands[0].length === 6 && s.hands[1].length === 6,
    'fresh six-card deal');
  assert(s.crib.length === 0 && s.starter === null, 'crib and starter cleared');
  const all = [...s.hands[0], ...s.hands[1], ...s.deck];
  assert(all.length === 52 && new Set(all).size === 52, 'redeal uses a full fresh deck');
}

/* -------------------------------------------- serialization round-trip */
{
  let s = createInitialState({ seed: 999 });
  for (let i = 0; i < 30 && getStatus(s).status === 'active'; i++) {
    s = JSON.parse(JSON.stringify(s));
    s = applyMove(s, chooseMove(s));
  }
  const thawed = JSON.parse(JSON.stringify(s));
  assert(JSON.stringify(legalMoves(thawed)) === JSON.stringify(legalMoves(s)),
    'game survives stringify/parse mid-run with identical legal moves');
}

/* ------------------------------------- full-game soak: engine + fairness */
{
  let finished = 0;
  let skunks = 0;
  let heels = 0;
  let brokeInvariant = false;
  const wins = [0, 0];
  for (let seed = 1; seed <= 120; seed++) {
    let s = createInitialState({ seed });
    let guard = 0;
    let prevTotals = [0, 0];
    while (getStatus(s).status === 'active' && guard++ < 5000) {
      s = applyMove(s, chooseMove(s));
      // scores only ever go up, never past 121
      if (s.scores[0] < prevTotals[0] || s.scores[1] < prevTotals[1] ||
          s.scores[0] > WIN_SCORE || s.scores[1] > WIN_SCORE) brokeInvariant = true;
      prevTotals = [s.scores[0], s.scores[1]];
      if (s.lastEvents.some((ev) => ev.kind === 'heels')) heels++;
      // card conservation whenever a starter is out
      if (s.starter && s.phase !== 'over') {
        const pilesCards = s.play
          ? [...s.play.pile, ...s.play.prevPiles.flat()].map((e) => e.card) : [];
        const inPlay = [...s.hands[0], ...s.hands[1], ...pilesCards];
        const everything = [...inPlay, ...s.crib, s.starter, ...s.deck];
        if (everything.length !== 52 || new Set(everything).size !== 52) brokeInvariant = true;
      }
    }
    const st = getStatus(s);
    if (st.status === 'over') {
      finished++;
      wins[st.winner]++;
      if (st.skunk) skunks++;
      if (s.scores[st.winner] !== WIN_SCORE) brokeInvariant = true;
      if (s.scores[1 - st.winner] >= WIN_SCORE) brokeInvariant = true;
    }
  }
  assert(finished === 120, `120/120 bot-vs-bot games finish (got ${finished})`);
  assert(!brokeInvariant, 'invariants held: monotone scores, 121 cap, 52 cards, one winner');
  assert(wins[0] > 20 && wins[1] > 20, `both seats win their share (${wins[0]}-${wins[1]})`);
  assert(heels > 0, `his heels showed up in the soak (${heels} times)`);
  console.log(`      soak: ${wins[0]}-${wins[1]} split, ${skunks} skunks, ${heels} heels`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
