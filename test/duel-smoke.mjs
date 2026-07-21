// Real-engine smoke (secondary to the deterministic coverage test): boots the
// actual WASM engine in headless Chromium, plays several auto/passed turns, and
// asserts the duel ADVANCES and never logs the mid-resolution freeze.
import { chromium } from 'playwright';
const URL = process.env.URL || 'http://localhost:4599/';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pg.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await pg.locator('nav button', { hasText: 'Duel' }).click();
const sb = pg.locator('button', { hasText: 'Start Duel' });
await sb.first().click();
try { await pg.waitForFunction(() => /LP/.test(document.body.innerText), { timeout: 90000 }); } catch {}
// advance turns: pass response windows, end the turn, or let the engine resolve
for (let i = 0; i < 32; i++) {
  await pg.waitForTimeout(400);
  const noResp = pg.locator('button', { hasText: 'No response' });
  const end = pg.locator('button', { hasText: 'End Turn' });
  const letEngine = pg.locator('button', { hasText: 'Let the engine' });
  if (await noResp.count()) { await noResp.first().click(); }
  else if (await end.count()) { await end.first().click(); }
  else if (await letEngine.count()) { await letEngine.first().click(); }
}
await pg.waitForTimeout(800);
const froze = await pg.evaluate(() => /waiting but no selection request|engine stalled — stopping|processing cap reached/.test(document.body.innerText));
// case-insensitive: the turn chip renders uppercase ("TURN 2") via CSS text-transform
const turnTxt = await pg.evaluate(() => (document.body.innerText.match(/Turn\s*(\d+)/i)||[])[1] || '0');
console.log('reachedTurn=' + turnTxt, 'freezeLogged=' + froze);
await b.close();
if (froze) { console.error('SMOKE FAIL: freeze/stall detected'); process.exit(1); }
if (Number(turnTxt) < 2) { console.error('SMOKE FAIL: duel did not advance past turn 1'); process.exit(1); }
console.log('SMOKE PASS: real engine advanced to turn ' + turnTxt + ' with no freeze.');
