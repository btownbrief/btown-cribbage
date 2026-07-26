# Btown Cribbage — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for the rules and architecture — this file adds the
rules an agent needs. Stephen is non-technical — explain consequential
changes in plain language.

## What this is

Two-player cribbage for Btown Games, Vermont-themed (the pegging board is
the Long Trail up the Green Mountains). Plain static site, **no build
step**: `index.html` + `style.css` + ES modules in `js/`. Deployed by
GitHub Pages via `.github/workflows/deploy.yml` on push. No backend, no
accounts, no analytics.

## The one non-negotiable

**Every rule of the game lives in `js/engine.js` (plus `js/scoring.js`
for the show count) and nowhere else.** Pure functions over one
JSON-serializable state object: `createInitialState`, `legalMoves`,
`applyMove` (returns a NEW state, never mutates), `getStatus`. They
import nothing DOM-related and never touch timers, `Date`, or
`Math.random` — the shuffle and the cut run on a seeded RNG whose state
lives inside the game state. A game must survive `JSON.stringify` →
`JSON.parse` → resume.

Why: online multiplayer gets bolted on later by syncing that exact state
object between phones. Rule logic in `main.js` or `bot.js` silently
breaks that plan. `js/bot.js` may only call the engine's public API;
`js/main.js` is UI only.

## Scoring accuracy IS the product

Cribbage players notice a single miscounted point, and muggins is
deliberately off — the app's whole promise is that it counts everything,
correctly, every time. Treat `scripts/test-scoring.mjs` as the contract:
its expected totals were verified by hand. If you touch `scoring.js` or
the pegging scorer in `engine.js`, add a hand-verified case for whatever
you changed. When a test and the code disagree, work the count out on
paper before deciding which one is wrong.

## Before you finish

Run `node scripts/test-scoring.mjs` **and** `node scripts/test-engine.mjs`
— plain Node, no framework, both must pass. If you touched the engine or
scoring, add assertions for the new behavior. If you touched the UI, load
the game at a phone-sized viewport and play at least one full hand (deal →
discard → cut → pegging → show → next deal), vs Champ AND pass-and-play,
or clearly say you couldn't and what you inspected instead. Say what you
verified.
