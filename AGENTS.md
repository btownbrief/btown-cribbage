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

## Online play (the rooms layer)

`js/rooms.js` is the fleet's vendored online-multiplayer client — the
canonical copy lives in `four-in-a-rowboat`; this repo copies it verbatim.
It talks to the shared Supabase rooms backend
(`btownbrief.github.io/supabase/rooms-2026-07-30.sql`): a room is a
4-letter code + the entire engine state as opaque JSON + a version number.
After your move you push the new state with the version you last saw;
everyone else polls. All rules stay in `engine.js` — `rooms.js` knows
nothing about cribbage. Host sits in seat 0 and is mapped to whichever
engine player acts first in the fresh seeded state; the joiner is seat 1.
If the backend SQL isn't installed yet, clients get a clean `not_ready`
error and the UI says online play isn't switched on.

`scripts/rooms-shim.mjs` is the verbatim fleet stand-in for the backend
(also canonical in `four-in-a-rowboat`) so everything is testable offline:
`scripts/test-rooms.mjs` drives the real client + engine through a full
online game against it.

## Scoring accuracy IS the product

Cribbage players notice a single miscounted point, and muggins is
deliberately off — the app's whole promise is that it counts everything,
correctly, every time. Treat `scripts/test-scoring.mjs` as the contract:
its expected totals were verified by hand. If you touch `scoring.js` or
the pegging scorer in `engine.js`, add a hand-verified case for whatever
you changed. When a test and the code disagree, work the count out on
paper before deciding which one is wrong.

## Before you finish

Run `node scripts/test-scoring.mjs`, `node scripts/test-engine.mjs`, and
`node scripts/test-rooms.mjs` — plain Node, no framework, all must pass.
If you touched the engine or scoring, add assertions for the new behavior.
If you touched the UI, load the game at a phone-sized viewport and play at
least one full hand (deal → discard → cut → pegging → show → next deal),
vs Champ AND pass-and-play, or clearly say you couldn't and what you
inspected instead. Say what you verified.
