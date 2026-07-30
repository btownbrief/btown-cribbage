// Online-rooms wiring test: drives the real vendored client (js/rooms.js)
// against the local shim (scripts/rooms-shim.mjs) as two simulated phones,
// then plays cribbage through the real engine. No network or Supabase.
//
//   node scripts/test-rooms.mjs

import { createRooms } from './rooms-shim.mjs';
import { createInitialState, legalMoves, applyMove, getStatus } from '../js/engine.js';

const GAME = 'btown-cribbage';

/* ------------------------------------------------- two-phone environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (key) => (stores.get(current).has(key) ? stores.get(current).get(key) : null),
  setItem: (key, value) => stores.get(current).set(key, String(value)),
  removeItem: (key) => stores.get(current).delete(key),
};
function device(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  current = id;
}
device('A');
device('B');

let passed = 0;
function t(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (err) {
    t(err && err.code === code, `${label} (got ${err && err.code})`);
  }
}

// Feed the shim's exact RPC handlers to the real client without opening a
// localhost port (some CI/sandbox environments prohibit listen()).
const { rpcs } = createRooms();
const shimFetch = async (url, options = {}) => {
  const match = new URL(url).pathname.match(/\/rest\/v1\/rpc\/(\w+)$/);
  if (!match || !rpcs[match[1]]) return new Response('{}', { status: 404 });
  try {
    const body = rpcs[match[1]](JSON.parse(options.body || '{}')) ?? {};
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ message: err.message }), {
      status: err.rpc ? 400 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
globalThis.fetch = shimFetch;
globalThis.BTOWN_ROOMS_URL = 'http://rooms-shim.test';
const { OnlineMatch, savedSession } = await import('../js/rooms.js');

/* ------------------------------------------------------------ the tests */

// create + join
device('A');
const initial = createInitialState({ seed: 7302026 });
const hostPlayer = initial.turn;
const host = await OnlineMatch.create({
  game: GAME, name: 'Pegger A', state: initial, seats: 2,
});
t(/^[A-Z2-9]{4}$/.test(host.code) && host.seat === 0 && host.status === 'waiting',
  'host creates room, seat 0');
t(hostPlayer === initial.turn, 'host maps to the engine player acting first');
t(savedSession(GAME)?.roomId === host.roomId, 'host session saved');

device('B');
await expectCode(OnlineMatch.join({ game: GAME, code: 'ZZZZ', name: 'X' }),
  'not_found', 'bad code rejected');
await expectCode(OnlineMatch.join({ game: 'crazy-eights', code: host.code, name: 'X' }),
  'wrong_game', 'wrong game rejected');
const guest = await OnlineMatch.join({
  game: GAME, code: ` ${host.code.toLowerCase()} `, name: 'Pegger B',
});
t(guest.seat === 1 && guest.status === 'playing',
  'guest joins (sloppy code ok), game starts');
t(guest.opponents().length === 1 && guest.opponents()[0].name === 'Pegger A',
  'guest sees host name');

device('A');
await host._fetch();
t(host.status === 'playing' && host.opponents()[0].name === 'Pegger B',
  'host poll sees game start');

// referee: push, sync, conflict
const firstMove = legalMoves(host.state)[0];
const stateAfterHost = applyMove(host.state, firstMove);
await host.push(stateAfterHost);
t(host.version === 1, 'host pushes move, version 1');

device('B');
await guest._fetch();
t(JSON.stringify(guest.state) === JSON.stringify(stateAfterHost),
  'guest poll receives the host move');
const stateAfterGuest = applyMove(guest.state, legalMoves(guest.state)[0]);
await guest.push(stateAfterGuest);
t(guest.version === 2, 'guest pushes reply, version 2');

device('A');
const staleAlternative = applyMove(stateAfterHost, legalMoves(stateAfterHost)[1]);
await expectCode(host.push(staleAlternative), 'version_conflict', 'stale push rejected');
t(host.version === 2 && JSON.stringify(host.state) === JSON.stringify(stateAfterGuest),
  'conflict refetches the truth');

// Full game through the engine. The phone mapped to state.turn acts, so
// consecutive plays after "go" and dealer-owned show counts work naturally.
device('A'); await host._fetch();
device('B'); await guest._fetch();
const phones = {
  [hostPlayer]: { match: host, device: 'A' },
  [1 - hostPlayer]: { match: guest, device: 'B' },
};
let randomState = 0x9e3779b9;
const randomIndex = (length) => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState % length;
};
let moves = 2;
const cap = 400;
let syncedEveryMove = true;
let sawSamePlayerPegging = false;
let sawDealerAlternate = false;
while (getStatus(host.state).status === 'active' && moves < cap) {
  const mover = phones[host.state.turn];
  device(mover.device);
  await mover.match._fetch();
  const before = mover.match.state;
  const choices = legalMoves(mover.match.state);
  const next = applyMove(mover.match.state, choices[randomIndex(choices.length)]);
  if (before.phase === 'play' && next.phase === 'play' && next.turn === before.turn) {
    sawSamePlayerPegging = true;
  }
  if (next.handNumber > initial.handNumber && next.dealer !== initial.dealer) {
    sawDealerAlternate = true;
  }
  await mover.match.push(next, { over: getStatus(next).status === 'over' });
  moves++;

  device('A'); await host._fetch();
  device('B'); await guest._fetch();
  if (JSON.stringify(host.state) !== JSON.stringify(guest.state)) {
    syncedEveryMove = false;
    break;
  }
}
const finished = getStatus(host.state).status === 'over';
t(syncedEveryMove, 'phones stay JSON-identical after every move');
t(sawSamePlayerPegging, 'same player can act again during a pegging go sequence');
t(sawDealerAlternate, 'dealer alternation comes through synced engine state');
t(JSON.stringify(host.state) === JSON.stringify(guest.state), 'end states identical');
t(finished || moves === cap, finished
  ? `full online cribbage game finishes in ${moves} moves`
  : `move cap reached cleanly with both phones synced (${moves})`);

// rematch: either phone deals into a finished room
if (finished) {
  device('B');
  const oldVersion = guest.version;
  await guest.push(createInitialState({ seed: 7302027 }), {});
  t(guest.status === 'playing' && guest.version === oldVersion + 1,
    'rematch deal accepted');
}

// resume after a "refresh"
device('A');
const resumed = await OnlineMatch.resume({ game: GAME });
t(resumed.roomId === host.roomId && resumed.seat === 0,
  'resume reattaches to the room');

// leave: other side sees the flag, session cleared
await resumed.leave();
t(savedSession(GAME) === null, 'leave clears the session');
device('B');
await guest._fetch();
t(guest.status === 'over' && guest.opponents()[0].left === true,
  'guest sees host left');

// full room turns a third phone away
device('A');
const h2 = await OnlineMatch.create({
  game: GAME, name: 'A', state: createInitialState({ seed: 11 }),
});
device('B');
await OnlineMatch.join({ game: GAME, code: h2.code, name: 'B' });
device('C');
await expectCode(OnlineMatch.join({ game: GAME, code: h2.code, name: 'C' }),
  'room_started', 'third phone turned away');

// backend not installed -> clean not_ready
{
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  const fresh = await import('../js/rooms.js?not-ready');
  await expectCode(
    fresh.OnlineMatch.create({ game: GAME, name: 'A', state: {} }),
    'not_ready', 'missing backend reads as not_ready');
}

console.log(`\nALL ROOMS TESTS PASSED (${passed} checks)`);
process.exit(0);
