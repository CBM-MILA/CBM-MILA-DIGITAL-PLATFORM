const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync('app.js', 'utf8');
const start = source.indexOf('function effectiveMatch(match) {');
const end = source.indexOf('function liveClockText(start) {', start);
assert.ok(start >= 0 && end > start, 'live match helpers exist');
const snippet = source.slice(start, end);
const now = Date.now();
const kickoff = new Date(now - 5 * 60 * 1000).toISOString();
const kickoffEpoch = Math.floor(new Date(kickoff).getTime() / 1000);
const ctx = {
  S: { liveControl: { active: true, matchId: '9001', kickoffEpoch, startedAt: kickoff,
    score: { home: 2, away: 0 } } },
  CBM: '733', Date, Number, String, Math,
  okD: value => Number.isFinite(new Date(value).getTime()),
  winMs: () => 120 * 60 * 1000
};
vm.createContext(ctx);
vm.runInContext(snippet, ctx);

let match = { id:'9001', home:'733', away:'729', kickoff, status:'scheduled', score:null };
let effective = ctx.effectiveMatch(match);
assert.strictEqual(effective.status, 'live');
assert.deepStrictEqual(JSON.parse(JSON.stringify(effective.score)), { home:2, away:0 },
  'manual score overlays the same kickoff when official score is not yet available');

match = { ...match, kickoff: new Date(now - 4 * 60 * 1000).toISOString() };
effective = ctx.effectiveMatch(match);
assert.strictEqual(effective.manualLive, undefined,
  'manual score from a prior kickoff cannot overlay a rescheduled fixture');

match = { id:'9001', home:'733', away:'729', kickoff, status:'live', score:{home:0,away:0} };
effective = ctx.effectiveMatch(match);
assert.strictEqual(effective.manualLive, undefined);
assert.deepStrictEqual(JSON.parse(JSON.stringify(effective.score)), { home:0, away:0 },
  'official live score including 0-0 overrides manual score when it becomes available');

match = { id:'9001', home:'733', away:'729', kickoff, status:'finished', score:{home:3,away:1} };
effective = ctx.effectiveMatch(match);
assert.strictEqual(effective.status, 'finished');
assert.deepStrictEqual(JSON.parse(JSON.stringify(effective.score)), { home:3, away:1 },
  'official full-time result always wins');
console.log('APP LIVE MATCH PRIORITY CHECKS PASSED');
