# BTOWN CRIBBAGE ⛰️🃏

Full two-player cribbage with the pegging board drawn as **the Long Trail**
winding up the Green Mountains — 121 at the summit. Play against **Champ**
the lake monster or pass the phone across the table. The app counts
**everything** — every fifteen, pair, run, flush, and his nobs is announced
and itemized, so newcomers learn the count by playing (and nobody's
sandbagging you with muggins). Part of
[Btown Games](https://play.btownbrief.com), the browser arcade of the
[BTown Brief](https://www.btownbrief.com).

**Play it live:** https://play.btownbrief.com/btown-cribbage/

## The rules it plays (standard 2-player cribbage)

- Race to **121**. Six cards dealt each; both players toss 2 to the
  **crib** (the dealer's bonus hand). Non-dealer cuts, dealer flips the
  starter — a Jack is **his heels**, 2 to the dealer on the spot.
- **The play**: alternate cards, announcing the running count, never past
  31. Exactly 15 pegs 2; pairs peg 2 / 6 / 12 (consecutive same-rank
  cards); runs of 3+ in any order among the latest cards peg their
  length; stuck under 31 you say **go** — last card of every sequence
  pegs 1 (2 if it lands on 31 exactly), then the count resets.
- **The show**, counted in strict order — non-dealer's hand, dealer's
  hand, then the crib — each with the starter as a fifth card. Fifteens 2
  each, pairs 2, runs their length (double runs and all), flush 4 or 5
  (**a crib flush needs all five**), his nobs 1 for the Jack matching the
  starter's suit.
- Dealer alternates each hand. The game ends the **instant** a peg hits
  121 — even mid-count. Win before your opponent reaches 91 and that's a
  **skunk** (the board marks the line at the 🦨).

## How it works

Plain static site — no build step. `index.html` + `style.css` + ES modules in `js/`:

| file | what it does |
| --- | --- |
| `js/engine.js` | **all** the game rules, as pure functions over one JSON-serializable state object (seeded RNG lives in the state — same seed, same deal); pegging-play scoring included |
| `js/scoring.js` | the show counter — scores any 4 cards + starter (crib flag included) and returns the full itemized breakdown, one line per fifteen/pair/run/flush/nobs |
| `js/bot.js` | Champ's brain — only calls the engine's public API; tries all 15 discards against every possible starter (keeping value vs. feeding the crib), pegs for points, leads low-safe |
| `js/main.js` | UI only: screens, taps, the Long Trail board (SVG, drawn in code), scoring callouts, the show panel, bot pacing, pass-and-play handoffs, localStorage resume |

The engine/UI split is deliberate: online multiplayer later just means
syncing the engine's state object between phones. Rule logic anywhere
outside `engine.js`/`scoring.js` breaks that plan — see `AGENTS.md`.

Every push to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Testing

```bash
node scripts/test-scoring.mjs   # the show counter, vs. hand-verified totals
node scripts/test-engine.mjs    # deal, heels, pegging, go/31, show order, full-game soak
```

Plain Node, no framework. The scoring table includes the perfect 29, a
28, a zero hand, double/triple/double-double runs, hand vs. crib
flushes, his nobs, and a 20,000-hand sweep asserting no impossible
totals (19, 25, 26, 27, or anything past 29). The engine suite covers
his heels, pegging sequences (15s, pairs royal, runs in any order,
go/31, count resets, last card), the strict show order — including both
players poised to cross 121 in the same hand — dealer alternation,
instant win at 121, serialization round-trips, and a 120-game
bot-vs-bot soak with card-conservation invariants.
