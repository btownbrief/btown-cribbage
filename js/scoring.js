/* BTOWN CRIBBAGE show-scoring — pure module, no DOM, no timers, no RNG.
 *
 * Scores a 4-card hand (or crib) plus the starter card, returning the full
 * itemized breakdown the way a cribbage player would call it out:
 * fifteens, pairs, runs, flush, and his nobs. This file is the single
 * source of truth for show scoring — engine.js imports it; nothing else
 * reimplements any of it.
 *
 * Public API:
 *   scoreHand(cards, starter, { isCrib }) ->
 *     { total, items: [{ kind, points, cards, label }] }
 *
 * Cards are 2-char strings: rank + suit, e.g. "5H", "TS" (T = ten).
 * Rules encoded here:
 *   - every distinct combination of cards totaling 15 pegs 2
 *   - each pair pegs 2 (three of a kind = 3 pairs = 6, four = 6 pairs = 12)
 *   - runs of 3+ score their length, once per distinct card combination
 *     (so 4-5-5-6 + 9 counts the 4-5-6 run twice); ace is always low
 *   - flush: 4 points when the four HAND cards share a suit, 5 when the
 *     starter matches too — but a CRIB flush needs all five (4-flush = 0)
 *   - his nobs: 1 for holding the Jack of the starter's suit
 */

export const RANK_ORDER = 'A23456789TJQK';

const VALUES = {
  A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 10, Q: 10, K: 10,
};

export const rankOf = (card) => card[0];
export const suitOf = (card) => card[1];
export const valueOf = (card) => VALUES[rankOf(card)];
export const runIndex = (card) => RANK_ORDER.indexOf(rankOf(card));

const RANK_NAMES = {
  A: 'ace', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', T: 'ten', J: 'jack', Q: 'queen', K: 'king',
};

export const rankName = (card) => RANK_NAMES[rankOf(card)];

/* ---------------------------------------------------------------- pieces */

/* Every subset of `cards` whose values total exactly 15. */
function fifteens(cards) {
  const found = [];
  const n = cards.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    const combo = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += valueOf(cards[i]); combo.push(cards[i]); }
    }
    if (sum === 15) found.push(combo);
  }
  return found;
}

/* Every unordered pair of same-rank cards. */
function pairs(cards) {
  const found = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (rankOf(cards[i]) === rankOf(cards[j])) found.push([cards[i], cards[j]]);
    }
  }
  return found;
}

/* Runs: find the maximal stretches of 3+ consecutive ranks, then emit one
 * run per distinct card combination (duplicated ranks multiply the runs —
 * that's how double and triple runs fall out naturally). */
function runs(cards) {
  const byIndex = new Map(); // run index -> cards of that rank
  for (const card of cards) {
    const idx = runIndex(card);
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    byIndex.get(idx).push(card);
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);

  const found = [];
  let start = 0;
  for (let i = 1; i <= indices.length; i++) {
    const broke = i === indices.length || indices[i] !== indices[i - 1] + 1;
    if (!broke) continue;
    const stretch = indices.slice(start, i);
    start = i;
    if (stretch.length < 3) continue;
    // one run per way of picking a single card of each rank in the stretch
    let combos = [[]];
    for (const idx of stretch) {
      const next = [];
      for (const combo of combos) {
        for (const card of byIndex.get(idx)) next.push(combo.concat([card]));
      }
      combos = next;
    }
    found.push(...combos);
  }
  return found;
}

/* ---------------------------------------------------------------- score */

export function scoreHand(cards, starter, options = {}) {
  if (!Array.isArray(cards) || cards.length !== 4 || !starter) {
    throw new Error('scoreHand needs exactly 4 hand cards plus a starter');
  }
  const isCrib = options.isCrib === true;
  const all = cards.concat([starter]);
  const items = [];

  let fifteenCount = 0;
  for (const combo of fifteens(all)) {
    fifteenCount++;
    items.push({
      kind: 'fifteen', points: 2, cards: combo,
      label: `fifteen ${fifteenCount * 2}`,
    });
  }

  for (const pair of pairs(all)) {
    items.push({
      kind: 'pair', points: 2, cards: pair,
      label: `pair of ${rankName(pair[0])}s`,
    });
  }

  for (const run of runs(all)) {
    items.push({
      kind: 'run', points: run.length, cards: run,
      label: `run of ${run.length}`,
    });
  }

  const handSuit = suitOf(cards[0]);
  if (cards.every((card) => suitOf(card) === handSuit)) {
    if (suitOf(starter) === handSuit) {
      items.push({
        kind: 'flush', points: 5, cards: all.slice(),
        label: 'five-card flush',
      });
    } else if (!isCrib) {
      // the crib flush must include the starter — a crib 4-flush is nothing
      items.push({
        kind: 'flush', points: 4, cards: cards.slice(),
        label: 'four-card flush',
      });
    }
  }

  const nobs = cards.find(
    (card) => rankOf(card) === 'J' && suitOf(card) === suitOf(starter),
  );
  if (nobs) {
    items.push({ kind: 'nobs', points: 1, cards: [nobs], label: 'his nobs' });
  }

  const total = items.reduce((sum, item) => sum + item.points, 0);
  return { total, items };
}
