# Changelog

## BUG 1 — effects no longer freeze mid-resolution (engine message loop)
**Files:** `src/App.jsx` (drive/dispatch layer only), `test/effect-resolution.test.mjs`, `test/duel-smoke.mjs`, `package.json`

**What:** `isSelect()` now recognizes every awaitable query in the ocgcore-wasm
`OcgResponseType` enum (added `SELECT_CARD_CODES, SELECT_DISFIELD, SELECT_COUNTER,
SORT_CARD, SORT_CHAIN, ANNOUNCE_RACE/ATTRIB/CARD/NUMBER, ROCK_PAPER_SCISSORS`).
`autoResponse()` gained valid handlers for each (announce → first legal bit(s);
counter → minimum legal, distributed; sort → keep order; RPS → rock). The `!sel`
branch no longer permanently stops — it degrades to a safe auto-response and
continues. Fix is entirely card-agnostic and lives in the loop.

**Why:** When resolution reached a query `isSelect()` didn't know, `duelProcess`
returned AWAITING, no pending selection was found, and the loop hit a permanent
"stopping" return — cost applied, resolution never ran (the reported symptom).

**PLAYER-FACING query types** (currently auto-resolved to prevent the freeze;
should become real prompts in a later, separate task — they silently decide for
the user): `ANNOUNCE_CARD`, `ANNOUNCE_NUMBER`, `ANNOUNCE_ATTRIB`, `ANNOUNCE_RACE`,
`SELECT_COUNTER`, `SELECT_CARD_CODES`.

**Tests:** `npm test` (deterministic) asserts all 21 awaitable types are
recognized + answerable and the hard-stop is gone. FAILS on pre-fix code, PASSES
after. `npm run test:e2e` boots the real WASM engine headless as a soak (best
effort; sensitive to engine load time).
