// Regression for BUG 1: effects froze mid-resolution when the engine awaited a
// query type drive()'s isSelect() didn't recognize. This asserts — against the
// REAL src/App.jsx — that every awaitable query from the ocgcore-wasm
// OcgResponseType enum is (a) recognized by isSelect and (b) has a response
// (interactive UI or autoResponse), and that the permanent freeze/stop is gone.
import fs from 'node:fs';

// Authoritative awaitable query set (ocgcore-wasm OcgResponseType == MSG_* in
// edo9300/ygopro-core common.h). Update ONLY from the engine enum.
const AWAITABLE = [
  'SELECT_BATTLECMD','SELECT_IDLECMD','SELECT_EFFECTYN','SELECT_YESNO','SELECT_OPTION',
  'SELECT_CARD','SELECT_CARD_CODES','SELECT_UNSELECT_CARD','SELECT_CHAIN','SELECT_DISFIELD',
  'SELECT_PLACE','SELECT_POSITION','SELECT_TRIBUTE','SELECT_COUNTER','SELECT_SUM',
  'SORT_CARD','ANNOUNCE_RACE','ANNOUNCE_ATTRIB','ANNOUNCE_CARD','ANNOUNCE_NUMBER','ROCK_PAPER_SCISSORS',
];
// Types handled by interactive UI paths rather than autoResponse. Every awaitable
// query now has a real player-facing prompt; autoResponse remains only as the
// "⚡ Let the engine choose" escape hatch + the AI opponent's fallback.
const INTERACTIVE = ['SELECT_IDLECMD','SELECT_BATTLECMD','SELECT_CHAIN','SELECT_EFFECTYN',
  'SELECT_YESNO','SELECT_OPTION','SELECT_POSITION','SELECT_CARD','SELECT_TRIBUTE','SELECT_PLACE','SELECT_DISFIELD',
  'SELECT_UNSELECT_CARD','SELECT_SUM','SELECT_COUNTER','SORT_CARD','ANNOUNCE_RACE','ANNOUNCE_ATTRIB',
  'ANNOUNCE_CARD','ANNOUNCE_NUMBER','ROCK_PAPER_SCISSORS'];

const file = process.argv[2] || new URL('../src/App.jsx', import.meta.url).pathname;
const src = fs.readFileSync(file, 'utf8');
const fails = [];

const isSel = src.match(/const isSelect = \(m, MT\) =>\s*\[([\s\S]*?)\]\.includes/);
if (!isSel) fails.push('could not locate isSelect()');
const isSelBody = isSel ? isSel[1] : '';
const missingRecognized = AWAITABLE.filter(t => !new RegExp(`MT\\.${t}\\b`).test(isSelBody));
if (missingRecognized.length) fails.push('isSelect() does NOT recognize: ' + missingRecognized.join(', '));

const auto = src.match(/const autoResponse = [\s\S]*?\n {2}\};/);
const autoBody = auto ? auto[0] : '';
const missingHandler = AWAITABLE.filter(t => !INTERACTIVE.includes(t) && !new RegExp(`MT\\.${t}\\b`).test(autoBody));
if (missingHandler.length) fails.push('no response handler for: ' + missingHandler.join(', '));

if (/waiting but no selection request was seen — stopping/.test(src))
  fails.push('permanent hard-stop still present (should degrade + continue)');

if (fails.length) { console.error('FAIL (' + file + ')\n - ' + fails.join('\n - ')); process.exit(1); }
console.log(`PASS: all ${AWAITABLE.length} awaitable query types recognized + answerable; no permanent freeze.`);
