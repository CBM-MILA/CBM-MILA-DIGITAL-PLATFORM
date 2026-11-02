const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const code = fs.readFileSync('Code.gs', 'utf8');
const ctx = { console, Date, Math, JSON, String, Number, Array, Object, RegExp, parseInt };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const evalIn = source => vm.runInContext(source, ctx);

const kickoffA = Math.floor(Date.parse('2026-11-07T15:00:00+01:00') / 1000);
const kickoffB = Math.floor(Date.parse('2026-11-14T15:00:00+01:00') / 1000);
const nowA = kickoffA * 1000 + 5 * 60 * 1000;
const nowB = kickoffB * 1000 + 5 * 60 * 1000;
const base = {
  club: { id: '733' },
  opponents: [{ id: '729', name: { ar: 'نجم تازوقاغت' } }],
  matches: []
};

let result = evalIn(`findStartedHomeMatch_(${JSON.stringify({
  ...base,
  matches: [{ id:'9001', home:'733', away:'729', kickoff:'2026-11-07T15:00:00+01:00', status:'postponed' }]
})}, ${nowA})`);
assert.strictEqual(result, null, 'postponed fixture is not treated as started');

result = evalIn(`findStartedHomeMatch_(${JSON.stringify({
  ...base,
  matches: [{ id:'9001', home:'733', away:'729', kickoff:'2026-11-07T15:00:00+01:00', status:'rescheduled' }]
})}, ${nowA})`);
assert.strictEqual(result.id, '9001', 'rescheduled home fixture enters the live watcher');
assert.strictEqual(result.kickoffEpoch, kickoffA, 'watcher returns exact kickoff generation');

function propsWith(value) {
  const values = new Map(value === undefined ? [] : [['CBM_PROMPTED_9001', String(value)]]);
  return { getProperty:k => values.get(k) || null, setProperty:(k,v)=>values.set(k,String(v)), values };
}
let props = propsWith(kickoffA);
ctx.props = props;
assert.strictEqual(evalIn(`livePromptAlreadySent_(props, {id:'9001', kickoffEpoch:${kickoffA}})`), true,
  'same kickoff is deduplicated');
assert.strictEqual(evalIn(`livePromptAlreadySent_(props, {id:'9001', kickoffEpoch:${kickoffB}})`), false,
  'new kickoff for same match ID triggers a fresh prompt');

// v8 stored Date.now() in milliseconds; retain deduplication for the same old kickoff.
props = propsWith(nowA);
ctx.props = props;
assert.strictEqual(evalIn(`livePromptAlreadySent_(props, {id:'9001', kickoffEpoch:${kickoffA}})`), true,
  'legacy millisecond prompt marker is recognized for the same kickoff');
assert.strictEqual(evalIn(`livePromptAlreadySent_(props, {id:'9001', kickoffEpoch:${kickoffB}})`), false,
  'legacy marker does not suppress a later rescheduled kickoff');

const kb = evalIn(`liveControlKeyboard_('9001', ${kickoffA})`);
for (const row of kb.inline_keyboard) for (const button of row) {
  assert.ok(button.callback_data.endsWith('|' + kickoffA), 'every score button is bound to the kickoff generation');
  assert.ok(button.callback_data.length <= 64, 'Telegram callback_data remains within 64-byte API limit');
}

console.log('LIVE CONTROL CHECKS PASSED');

// Exercise the actual Telegram callback handler with an in-memory Script Properties store.
const scriptProperties = new Map();
const store = {
  getProperty: key => scriptProperties.has(key) ? scriptProperties.get(key) : null,
  setProperty: (key, value) => scriptProperties.set(key, String(value)),
  deleteProperty: key => scriptProperties.delete(key)
};
const callbackAnswers = [];
ctx.telegramProps_ = () => store;
ctx.telegramAdminId_ = () => '5315858823';
ctx.answerTelegramCallback_ = (id, message) => callbackAnswers.push({ id, message });
ctx.editTelegramControlMessage_ = () => {};
ctx.LockService = {
  getScriptLock: () => ({ waitLock: () => true, releaseLock: () => true })
};
function sendCallback(action, generation, fromId = '5315858823', chatId = '5315858823', chatType = 'private') {
  ctx.handleTelegramControlUpdate_({ callback_query: {
    id: 'cb-' + action,
    from: { id: Number(fromId) },
    data: `cbmctl|${action}|9001|${generation}`,
    message: { message_id: 77, chat: { id: Number(chatId), type: chatType } }
  }});
}

const liveEpoch = Math.floor(Date.now() / 1000) - 120;
store.setProperty('CBM_PROMPTED_9001', String(liveEpoch));
sendCallback('yes', liveEpoch - 60);
assert.strictEqual(store.getProperty('CBM_LIVE_CONTROL_STATE'), null, 'old Yes prompt is rejected after the kickoff generation changes');
sendCallback('no', liveEpoch - 60);
assert.strictEqual(store.getProperty('CBM_LIVE_CONTROL_STATE'), null, 'old No prompt is also rejected after rescheduling');
sendCallback('yes', liveEpoch);
let liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.strictEqual(liveState.active, true, 'admin can activate the private live-control session');
assert.strictEqual(liveState.kickoffEpoch, liveEpoch, 'active session records its kickoff generation');

sendCallback('home', liveEpoch - 7 * 24 * 60 * 60);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.deepStrictEqual(liveState.score, { home: 0, away: 0 }, 'old kickoff buttons cannot change a rescheduled match score');

sendCallback('home', liveEpoch);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.deepStrictEqual(liveState.score, { home: 1, away: 0 }, 'current kickoff button increments the home score');
sendCallback('away', liveEpoch);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.deepStrictEqual(liveState.score, { home: 1, away: 1 }, 'away score increments independently');
sendCallback('undo', liveEpoch);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.deepStrictEqual(liveState.score, { home: 1, away: 0 }, 'undo removes only the latest score event');

sendCallback('home', liveEpoch, '999999');
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.deepStrictEqual(liveState.score, { home: 1, away: 0 }, 'non-admin account cannot alter the result');
sendCallback('home', liveEpoch, '5315858823', '-100123', 'supergroup');
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.deepStrictEqual(liveState.score, { home: 1, away: 0 }, 'group callbacks are rejected even when sent by the admin');

sendCallback('stop', liveEpoch);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.strictEqual(liveState.active, false, 'admin can stop the manual control session');

sendCallback('no', liveEpoch);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.strictEqual(liveState.active, false, 'No selection keeps manual score control disabled');
assert.strictEqual(liveState.choice, 'official_only', 'No selection records official-only mode');

const nextEpoch = liveEpoch + 60;
store.setProperty('CBM_PROMPTED_9001', String(nextEpoch));
sendCallback('yes', nextEpoch);
liveState = JSON.parse(store.getProperty('CBM_LIVE_CONTROL_STATE'));
assert.strictEqual(liveState.active, true, 'a new kickoff generation can start a fresh control session');
assert.strictEqual(liveState.kickoffEpoch, nextEpoch, 'the fresh session is bound to the new kickoff');
console.log('TELEGRAM CALLBACK HANDLER CHECKS PASSED');
