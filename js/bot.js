/* Champ the bot — picks a move using ONLY the engine's public API.
 * No rule logic lives here: the bot chooses among legalMoves(state) and
 * uses the engine/scoring modules to evaluate them.
 *
 * Discarding: tries all 15 ways to toss 2 of 6, keeps the pair that
 * maximizes the kept hand's average show score over every unseen starter,
 * plus an estimate of what the toss feeds the crib — added when it's
 * Champ's crib, subtracted when it's yours.
 *
 * Pegging: legal plays are scored for immediate points (15s, pairs, runs,
 * 31), then nudged by table wisdom — lead low-safe (under 5 can't be
 * fifteened), don't lead a 5, avoid leaving the count at 5 or 21.
 */

import { legalMoves, scorePegging, valueOf, rankOf } from './engine.js';
import { scoreHand, runIndex } from './scoring.js';

export function chooseMove(state) {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];
  if (state.phase === 'discard') return chooseDiscard(state, moves);
  if (state.phase === 'play') return choosePlay(state, moves);
  return moves[0];
}

/* ------------------------------------------------------------- discard */

/* Rough value the two tossed cards hand to a crib: pairs, fifteens, fives
 * (they pair with every ten-card), touching cards that breed runs, and a
 * whiff of nobs for a jack. */
function cribTossValue(a, b) {
  let v = 0;
  if (rankOf(a) === rankOf(b)) v += 2;
  if (valueOf(a) + valueOf(b) === 15) v += 2;
  const gap = Math.abs(runIndex(a) - runIndex(b));
  if (gap === 1) v += 1;
  else if (gap === 2) v += 0.5;
  for (const card of [a, b]) {
    if (rankOf(card) === '5') v += 1;
    if (rankOf(card) === 'J') v += 0.25;
  }
  return v;
}

function chooseDiscard(state, moves) {
  const me = state.turn;
  const hand = state.hands[me];
  const myCrib = state.dealer === me;

  // every card not in my hand is an equally likely starter
  const seen = new Set(hand);
  const unseen = [];
  for (const suit of ['S', 'H', 'D', 'C']) {
    for (const rank of 'A23456789TJQK') {
      const card = rank + suit;
      if (!seen.has(card)) unseen.push(card);
    }
  }

  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    const kept = hand.filter((card) => !move.cards.includes(card));
    let sum = 0;
    for (const starter of unseen) {
      sum += scoreHand(kept, starter).total;
    }
    const avgKeep = sum / unseen.length;
    const toss = cribTossValue(move.cards[0], move.cards[1]);
    const score = avgKeep + (myCrib ? toss : -toss);
    if (score > bestScore) { bestScore = score; best = move; }
  }
  return best;
}

/* ------------------------------------------------------------- pegging */

function choosePlay(state, moves) {
  const pile = state.play.pile;
  const count = state.play.count;
  const leading = pile.length === 0;

  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    const value = valueOf(move.card);
    const newCount = count + value;
    const newPile = pile.concat([{ card: move.card, player: state.turn }]);

    let points = scorePegging(newPile, newCount)
      .reduce((sum, item) => sum + item.points, 0);
    if (newCount === 31) points += 2;

    let score = points * 100;
    if (newCount === 5) score -= 30;              // gift-wraps a fifteen
    if (newCount === 21) score -= 20;             // any ten-card makes 31
    if (leading && rankOf(move.card) === '5') score -= 30; // never lead a 5
    if (leading && value >= 5) score -= 10;       // lead low-safe
    score += value;                               // shed high cards early
    if (score > bestScore) { bestScore = score; best = move; }
  }
  return best;
}
