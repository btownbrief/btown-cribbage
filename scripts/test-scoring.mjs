/* Show-scoring test — plain Node, no framework. Run: node scripts/test-scoring.mjs
 * Every expected total below was worked out by hand, the way you'd count
 * it over the board. If this file and scoring.js disagree, trust this file
 * and fix scoring.js — a cribbage app that miscounts is worthless. */

import { scoreHand } from '../js/scoring.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

function check(hand, starter, expected, name, options = {}) {
  const result = scoreHand(hand, starter, options);
  const ok = result.total === expected;
  assert(ok, `${name} = ${expected}`);
  if (!ok) {
    console.error(`      got ${result.total}: ` +
      result.items.map((i) => `${i.label}(${i.points})`).join(', '));
  }
  return result;
}

/* ------------------------------------------------------ the famous ones */

// The perfect 29: J + three 5s, starter is the 5 matching the Jack's suit.
// Fifteens: {5,5,5} x4 = 8, {J,5} x4 = 8. Pairs: six pairs of 5s = 12.
// His nobs = 1. 8+8+12+1 = 29.
{
  const r = check(['JS', '5H', '5D', '5C'], '5S', 29, 'perfect 29 (J555 + 5 of the jack suit)');
  assert(r.items.filter((i) => i.kind === 'fifteen').length === 8, '29 hand: eight fifteens');
  assert(r.items.filter((i) => i.kind === 'pair').length === 6, '29 hand: six pairs');
  assert(r.items.filter((i) => i.kind === 'nobs').length === 1, '29 hand: his nobs');
}

// 28: four 5s + any ten-card. Fifteens 16, pairs 12, no nobs.
check(['5S', '5H', '5D', '5C'], 'TH', 28, '28 (four 5s + a ten)');

// 28 the other way: J + three 5s, but the starter 5 does NOT match the
// Jack's suit — the nobs point evaporates.
check(['JS', '5C', '5D', '5S'], '5H', 28, '28 (J555, nobs misses by a suit)');

// A stone-cold zero.
check(['2H', '4S', '6D', '8C'], 'KH', 0, 'zero hand');

/* -------------------------------------------------------- runs, multiplied */

// Double run of 3: 4-5-5-6 + 9. Runs 4-5-6 twice = 6, pair of 5s = 2,
// fifteens {4,5,6} x2 and {6,9} = 6. Total 14.
{
  const r = check(['4H', '5C', '5D', '6S'], '9H', 14, 'double run of 3 (4556 + 9)');
  assert(r.items.filter((i) => i.kind === 'run').length === 2, 'double run: two run items');
  assert(r.items.every((i) => i.kind !== 'run' || i.points === 3), 'double run: each run is 3');
}

// Triple run: 4-4-4-5 + 6. Runs 4-5-6 three ways = 9, pairs royal = 6,
// fifteens {4,5,6} x3 = 6. Total 21.
check(['4H', '4C', '4D', '5S'], '6H', 21, 'triple run (4445 + 6)');

// Double double run: 7-7-8-8 + 9. Runs 7-8-9 four ways = 12, two pairs = 4,
// fifteens {7,8} x4 = 8. Total 24.
check(['7H', '7C', '8D', '8S'], '9H', 24, 'double double run (7788 + 9)');

// Run of 5: A-2-3-4 + 5. One run of 5, plus the whole hand sums to 15. Total 7.
{
  const r = check(['2H', '3C', '4D', '5S'], 'AH', 7, 'run of 5 (A2345, mixed suits)');
  assert(r.items.some((i) => i.kind === 'run' && i.points === 5), 'run of 5 scores 5');
  assert(!r.items.some((i) => i.kind === 'run' && i.points === 3), 'no sub-runs counted inside a run of 5');
}

// Runs never wrap around: Q-K-A-2 + J gives only the J-Q-K run of 3.
check(['QH', 'KC', 'AD', '2S'], 'JH', 3, 'no wraparound (QKA2 + J is just J-Q-K)');

// The best of the 6-7-8-9 family: 6789 + 8. Fifteens {7,8} x2 and {6,9} = 6,
// double run of 4 = 8, pair of 8s = 2. Total 16.
check(['6H', '7C', '8D', '9S'], '8H', 16, 'double run of 4 (6789 + 8)');

// A classic 24: 4-4-5-5 + 6. Runs 4-5-6 four ways = 12, two pairs = 4,
// fifteens {4,5,6} x4 = 8.
check(['4H', '4C', '5D', '5S'], '6H', 24, '24 hand (4455 + 6)');

/* ------------------------------------------------------------- flushes */

// Four hand cards in hearts, starter off-suit: flush 4 + fifteens {6,9}
// and {2,9,4} = 8.
check(['2H', '6H', '9H', 'KH'], '4S', 8, 'hand flush of 4');

// Same hand, starter also hearts: flush becomes 5. Total 9.
check(['2H', '6H', '9H', 'KH'], '4H', 9, 'hand flush of 5 (starter matches)');

// THE CRIB RULE: a crib four-flush scores ZERO for flush — only the
// fifteens (4) survive.
{
  const r = check(['2H', '6H', '9H', 'KH'], '4S', 4, 'crib four-flush scores no flush', { isCrib: true });
  assert(!r.items.some((i) => i.kind === 'flush'), 'crib 4-flush: no flush item at all');
}

// But a five-card crib flush is fine: same 9 as the hand.
check(['2H', '6H', '9H', 'KH'], '4H', 9, 'crib five-flush counts', { isCrib: true });

/* ---------------------------------------------------------------- nobs */

// His nobs rides along: J-2-3-K + 8, jack matches the starter's suit.
// Fifteens {J,2,3} and {K,2,3} = 4, nobs 1. Total 5.
check(['JH', '2S', '3D', 'KC'], '8H', 5, 'his nobs (+ two fifteens)');

// A jack as the STARTER is not nobs for anyone (that 2 was his heels,
// pegged at the cut — not a show point).
check(['2S', '3D', 'KC', '9H'], 'JH', 4, 'starter jack is not nobs');

// Nobs needs the right suit.
check(['JH', '2S', '3D', 'KC'], '8D', 4, 'wrong-suit jack: no nobs');

/* ---------------------------------------------------- assorted counting */

// 5-5-5-J + K: fifteens {5,5,5}, {J,5} x3, {K,5} x3 = 14, pairs royal 6,
// nobs (JS vs KS) 1. Total 21.
check(['5H', '5C', '5D', 'JS'], 'KS', 21, '555J + K with nobs');

// Every distinct fifteen combination counts: 7-8 x4 = 8, plus the sneaky
// {7,7,A} = 2, plus two pairs = 4. Total 14. (The ace earns its keep.)
check(['7H', '8C', '7D', '8S'], 'AH', 14, 'five fifteens in 7788 + A');

// Face cards are worth 10 but run in order: T-J-Q + K + 5.
// Fifteens {5,T},{5,J},{5,Q},{5,K} = 8, run T-J-Q-K = 4. Total 12.
check(['TH', 'JC', 'QD', 'KS'], '5H', 12, 'TJQK + 5 (four fifteens, run of 4)');

/* ------------------------------------------------------------ guardrails */

{
  let threw = false;
  try { scoreHand(['5H', '5C', '5D'], '5S'); } catch (e) { threw = true; }
  assert(threw, 'rejects a 3-card hand');
  threw = false;
  try { scoreHand(['5H', '5C', '5D', 'JS', 'KS'], '5S'); } catch (e) { threw = true; }
  assert(threw, 'rejects a 5-card hand');
}

/* ------------------------------------------- impossible-total sweep
 * No cribbage hand can score 19, 25, 26, or 27, and none beats 29.
 * Sweep a big deterministic sample of 5-card deals and make sure the
 * scorer agrees — a cheap net that catches whole classes of bugs. */
{
  const deck = [];
  for (const suit of 'SHDC') for (const rank of 'A23456789TJQK') deck.push(rank + suit);
  const impossible = new Set([19, 25, 26, 27]);
  let lcg = 12345;
  const rand = () => (lcg = (lcg * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  let bad = 0;
  let best = 0;
  for (let trial = 0; trial < 20000; trial++) {
    const cards = deck.slice();
    for (let i = 0; i < 5; i++) {
      const j = i + Math.floor(rand() * (cards.length - i));
      const tmp = cards[i]; cards[i] = cards[j]; cards[j] = tmp;
    }
    const total = scoreHand(cards.slice(0, 4), cards[4]).total;
    if (impossible.has(total) || total > 29) {
      bad++;
      if (bad < 4) console.error(`      impossible total ${total} for ${cards.slice(0, 5).join(' ')}`);
    }
    if (total > best) best = total;
  }
  assert(bad === 0, '20,000 random hands: never 19/25/26/27, never above 29');
  assert(best >= 16, `sweep sanity: saw real scores (best was ${best})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
