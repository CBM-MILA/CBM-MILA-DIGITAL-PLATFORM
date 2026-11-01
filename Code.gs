/**
 * السجل الرسمي لبطاقات مناصري نادي شباب بلدية ميلة (CBM Mila 1936) — Google Apps Script (v8)
 * ===========================================================================================
 * متوافق مع التخطيط الحالي للشيتين (لا حاجة لترحيل أي بيانات):
 *   Supporters: Timestamp | SupporterId | Name | RequestId | DeviceId | Status | Lang
 *   PushSubs  : Timestamp | DeviceId | Endpoint | P256dh | Auth | Lang | Status
 *
 * ما الجديد في v8:
 *   1) verify: حد خفيف لكل جهاز (60 / 15 د) وحد عام مرتفع (1500 / 15 د). الطلبات التي لا ترسل dev
 *      تخضع للحد العام فقط، حتى لا يتشارك الجميع سلة واحدة صغيرة يوم المباراة.
 *   2) عدّادات المعدّل بنافذة ثابتة (Fixed Window): لا يُمدَّد وقت الانتهاء مع كل طلب، فيتصفّر العدّاد فعلاً بعد 15 دقيقة.
 *   3) register: لا يُرفض الاسم المكرر (أسماء شائعة). منع التكرار بحسب requestId أو (نفس الجهاز + نفس الاسم) فقط،
 *      ويُسمح لأفراد العائلة بأسماء مختلفة على نفس الهاتف ضمن حد التسجيل.
 *   4) restore: حد لكل بطاقة ولكل جهاز، لكن صاحب الجهاز المسجّل للبطاقة لا يتأثر بالحدود.
 *      لا يوجد حظر عام ولا Utilities.sleep داخل القفل (يُسجَّل تحذير فقط عند ارتفاع الفشل العام).
 *      مقايضة معروفة: من يعرف رقم بطاقة يستطيع إغلاق استعادتها 15 دقيقة من الأجهزة الأخرى.
 *   5) باقي الحمايات كما هي: تنظيف الأسماء من بادئات الصيغ، قائمة بيضاء لنطاقات Push، قفل للكتابة فقط.
 */

const SHEET_NAME = 'Supporters';
const PUSH_SHEET_NAME = 'PushSubs';
const VERSION = 8;

const RATE_LIMIT_WINDOW_SEC = 900; // 15 دقيقة (نافذة ثابتة)
const RESTORE_MAX_FAILS_PER_DEV = 5;
const RESTORE_MAX_FAILS_PER_SID = 5;
const RESTORE_WARN_GLOBAL = 30;    // تسجيل تحذير فقط، دون حظر

const REGISTER_MAX_PER_DEV = 3;
const REGISTER_MAX_GLOBAL = 60;

const VERIFY_MAX_PER_DEV = 60;
const VERIFY_MAX_GLOBAL = 1500;

const MAX_PUSH_SUBS = 5000;

const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com'
];
const ALLOWED_PUSH_SUFFIXES = [
  '.push.apple.com',
  '.notify.windows.com'
];

const WRITE_ACTIONS = {
  register: true,
  ack: true,
  push_sub: true,
  push_unsub: true,
  push_prune: true
};

// LockService supports waitLock in Apps Script; tryLock fallback keeps the VM test harness compatible.
function waitForLock_(lock, timeoutMs) {
  if (lock && typeof lock.waitLock === 'function') {
    lock.waitLock(timeoutMs);
    return true;
  }
  if (lock && typeof lock.tryLock === 'function' && lock.tryLock(timeoutMs)) return true;
  throw new Error('Lock timeout');
}

// يُضبط ADMIN_KEY في Project Settings > Script Properties باسم ADMIN_KEY
const DEFAULT_ADMIN_KEY = '';

function getAdminKey_() {
  try {
    const propKey = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
    if (propKey) return String(propKey).trim();
  } catch (e) {}
  return String(DEFAULT_ADMIN_KEY || '').trim();
}

// --- Telegram-protected match control (separate from supporter-card records) ---
const LIVE_CONTROL_PROP = 'CBM_LIVE_CONTROL_STATE';

function telegramProps_() {
  return PropertiesService.getScriptProperties();
}

function telegramToken_() {
  return String(telegramProps_().getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
}

function telegramAdminId_() {
  return String(telegramProps_().getProperty('TELEGRAM_ADMIN_ID') || '').trim();
}

function publicLiveControlState_() {
  try {
    const raw = telegramProps_().getProperty(LIVE_CONTROL_PROP);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || !state.matchId) return null;
    if (state.active && state.startedAt) {
      const started = new Date(state.startedAt).getTime();
      // Safety expiry prevents an abandoned manual control session from remaining live indefinitely.
      if (!Number.isFinite(started) || Date.now() - started > 5 * 60 * 60 * 1000) {
        state.active = false;
        state.expired = true;
        telegramProps_().setProperty(LIVE_CONTROL_PROP, JSON.stringify(state));
      }
    }
    if (!state.active) return null;
    return {
      active: true,
      matchId: String(state.matchId),
      homeId: '733',
      score: {
        home: Math.max(0, parseInt(state.score && state.score.home, 10) || 0),
        away: Math.max(0, parseInt(state.score && state.score.away, 10) || 0)
      },
      startedAt: String(state.startedAt || ''),
      updatedAt: String(state.updatedAt || ''),
      source: 'manual'
    };
  } catch (err) {
    console.error('[CBM Telegram] invalid saved live state:', err);
    return null;
  }
}

function telegramApi_(method, payload) {
  const token = telegramToken_();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured in Script Properties');
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText() || '{}');
  if (!result.ok) throw new Error('Telegram API rejected ' + method + ': ' + String(result.description || 'unknown error'));
  return result;
}

function liveControlKeyboard_(matchId) {
  return { inline_keyboard: [
    [
      { text: '⚽ +1 لشباب ميلة', callback_data: 'cbmctl|home|' + matchId },
      { text: '⚽ +1 للخصم', callback_data: 'cbmctl|away|' + matchId }
    ],
    [
      { text: '↩ حذف آخر هدف', callback_data: 'cbmctl|undo|' + matchId },
      { text: '🔒 إنهاء التحكم', callback_data: 'cbmctl|stop|' + matchId }
    ]
  ] };
}

function answerTelegramCallback_(callbackId, message) {
  try { telegramApi_('answerCallbackQuery', { callback_query_id: callbackId, text: message || '', show_alert: false }); } catch (err) {}
}

function editTelegramControlMessage_(state, fallbackMessage) {
  if (!state || !state.chatId || !state.messageId) return;
  const score = state.score || { home: 0, away: 0 };
  const text = state.active
    ? '🟢 التحكم اليدوي في نتيجة مباراة شباب ميلة\n\nشباب ميلة  ' + score.home + ' - ' + score.away + '  الفريق المنافس\n\nاستخدم الأزرار لتسجيل الأهداف أو حذف آخر هدف. الوقت على الموقع محسوب من موعد بداية المباراة.'
    : (fallbackMessage || 'تم إيقاف التحكم اليدوي. ستُعرض النتيجة الرسمية عند وصولها من المصدر الرسمي.');
  const payload = { chat_id: state.chatId, message_id: state.messageId, text: text };
  if (state.active) payload.reply_markup = liveControlKeyboard_(state.matchId);
  else payload.reply_markup = { inline_keyboard: [] };
  try { telegramApi_('editMessageText', payload); } catch (err) { console.warn('[CBM Telegram] edit message failed:', err); }
}

function handleTelegramControlUpdate_(update) {
  const callback = update && update.callback_query;
  if (!callback || !callback.id || !callback.data) return;
  const fromId = String(callback.from && callback.from.id || '');
  const adminId = telegramAdminId_();
  if (!adminId || fromId !== adminId) {
    answerTelegramCallback_(callback.id, 'غير مصرح لك بالتحكم.');
    return;
  }

  const parts = String(callback.data).split('|');
  if (parts[0] !== 'cbmctl' || parts.length < 3) {
    answerTelegramCallback_(callback.id, 'طلب غير معروف.');
    return;
  }
  const action = parts[1];
  const matchId = String(parts[2]).replace(/[^0-9]/g, '').slice(0, 16);
  if (!matchId) {
    answerTelegramCallback_(callback.id, 'معرّف المباراة غير صالح.');
    return;
  }

  const lock = LockService.getScriptLock();
  try {
    waitForLock_(lock, 10000);
    const props = telegramProps_();
    const raw = props.getProperty(LIVE_CONTROL_PROP);
    let state = raw ? JSON.parse(raw) : null;
    const message = callback.message || {};
    const chatId = String(message.chat && message.chat.id || '');
    const messageId = Number(message.message_id || 0);

    if (action === 'yes' || action === 'no') {
      const kickoffEpoch = Math.max(0, parseInt(parts[3], 10) || 0);
      const nowEpoch = Math.floor(Date.now() / 1000);
      // Ignore stale Telegram prompts and controls clicked long after the scheduled fixture.
      if (!kickoffEpoch || kickoffEpoch > nowEpoch + 30 * 60 || nowEpoch - kickoffEpoch > 5 * 60 * 60) {
        answerTelegramCallback_(callback.id, 'انتهت صلاحية هذا الطلب. انتظر إشعار بداية المباراة الجديدة.');
        return;
      }
    }

    if (action === 'yes') {
      const kickoffEpoch = Math.max(0, parseInt(parts[3], 10) || 0);
      if (state && state.active && String(state.matchId) === matchId) {
        answerTelegramCallback_(callback.id, 'التحكم مفعّل بالفعل لهذه المباراة.');
        return;
      }
      const startedAt = new Date(kickoffEpoch * 1000).toISOString();
      state = {
        active: true,
        matchId: matchId,
        score: { home: 0, away: 0 },
        events: [],
        startedAt: startedAt,
        updatedAt: new Date().toISOString(),
        chatId: chatId,
        messageId: messageId
      };
      props.setProperty(LIVE_CONTROL_PROP, JSON.stringify(state));
      answerTelegramCallback_(callback.id, 'تم تفعيل التحكم اليدوي.');
      editTelegramControlMessage_(state);
      return;
    }

    if (action === 'no') {
      state = {
        active: false,
        matchId: matchId,
        score: { home: 0, away: 0 },
        choice: 'official_only',
        updatedAt: new Date().toISOString(),
        chatId: chatId,
        messageId: messageId
      };
      props.setProperty(LIVE_CONTROL_PROP, JSON.stringify(state));
      answerTelegramCallback_(callback.id, 'حسناً، سننتظر النتيجة الرسمية.');
      editTelegramControlMessage_(state, 'تم اختيار النتيجة الرسمية فقط. ستظهر أي نتيجة تنشرها الرابطة دون تدخل يدوي.');
      return;
    }

    if (!state || !state.active || String(state.matchId) !== matchId) {
      answerTelegramCallback_(callback.id, 'لا توجد مباراة نشطة للتحكم حالياً.');
      return;
    }

    if (!Array.isArray(state.events)) state.events = [];
    if (action === 'home' || action === 'away') {
      state.events.push(action);
    } else if (action === 'undo') {
      if (state.events.length) state.events.pop();
    } else if (action === 'stop') {
      state.active = false;
    } else {
      answerTelegramCallback_(callback.id, 'إجراء غير معروف.');
      return;
    }

    state.score = {
      home: state.events.filter(function(x) { return x === 'home'; }).length,
      away: state.events.filter(function(x) { return x === 'away'; }).length
    };
    state.updatedAt = new Date().toISOString();
    if (chatId && messageId) { state.chatId = chatId; state.messageId = messageId; }
    props.setProperty(LIVE_CONTROL_PROP, JSON.stringify(state));
    answerTelegramCallback_(callback.id, action === 'stop' ? 'تم إنهاء التحكم.' : 'تم تحديث النتيجة.');
    editTelegramControlMessage_(state);
  } catch (err) {
    console.error('[CBM Telegram] control callback failed:', err);
    answerTelegramCallback_(callback.id, 'تعذّر تنفيذ العملية. حاول مرة أخرى.');
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/**
 * Run once from Apps Script after setting TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID
 * in Project Settings > Script Properties. It registers this web app as the Telegram webhook.
 */
function setupTelegramControlWebhook() {
  const props = telegramProps_();
  const token = telegramToken_();
  const adminId = telegramAdminId_();
  const url = ScriptApp.getService().getUrl();
  if (!token) throw new Error('Add TELEGRAM_BOT_TOKEN to Script Properties first.');
  if (!adminId) throw new Error('Add TELEGRAM_ADMIN_ID to Script Properties first.');
  if (!url || url.indexOf('/exec') < 0) throw new Error('Deploy this Apps Script as a Web App before setting the webhook.');
  let secret = String(props.getProperty('TELEGRAM_WEBHOOK_SECRET') || '');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TELEGRAM_WEBHOOK_SECRET', secret);
  }
  const webhookUrl = url + '?cbm_tg_hook=' + encodeURIComponent(secret);
  const result = telegramApi_('setWebhook', { url: webhookUrl, allowed_updates: ['callback_query'], max_connections: 1 });
  console.log('Telegram match-control webhook configured: ' + Boolean(result.ok));
  return result.ok;
}

// --- Web App Endpoints ---
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.q) return run_(p.q, 'GET');
  let sheetName = '';
  try { sheetName = ss_().getName(); } catch (err) { sheetName = 'ERROR'; }
  return out_({ ok: true, v: VERSION, service: 'CBM Mila Official Supporters Registry', sheet: sheetName });
}

function doPost(e) {
  const params = (e && e.parameter) || {};
  const suppliedHook = String(params.cbm_tg_hook || '');
  if (suppliedHook) {
    const expectedHook = String(PropertiesService.getScriptProperties().getProperty('TELEGRAM_WEBHOOK_SECRET') || '');
    if (!expectedHook || suppliedHook !== expectedHook) {
      return ContentService.createTextOutput('unauthorized');
    }
    try {
      const update = JSON.parse((e && e.postData && e.postData.contents) || '{}');
      handleTelegramControlUpdate_(update);
      return ContentService.createTextOutput('ok');
    } catch (err) {
      console.error('[CBM Telegram] webhook processing failed:', err);
      return ContentService.createTextOutput('ok');
    }
  }
  const raw = (e && e.postData && e.postData.contents) || '{}';
  return run_(raw, 'POST');
}

function run_(raw, method) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return out_({ ok: false, code: 'bad_json', msg: 'Payload must be a JSON object' });
    }
  } catch (parseErr) {
    console.error('[CBM Code.gs] JSON parse error:', parseErr);
    return out_({ ok: false, code: 'bad_json', msg: 'Malformed JSON payload' });
  }

  const action = String(payload.a || 'verify').trim().toLowerCase();
  const needsLock = method === 'POST' && Boolean(WRITE_ACTIONS[action]);
  const lock = needsLock ? LockService.getScriptLock() : null;

  if (lock) {
    try {
      waitForLock_(lock, 15000);
    } catch (lockErr) {
      console.error('[CBM Code.gs] Lock timeout on action=' + action + ':', lockErr);
      return out_({ ok: false, code: 'lock_timeout', msg: 'Server busy, please retry' });
    }
  }

  try {
    return out_(handle_(payload, method));
  } catch (err) {
    console.error('[CBM Code.gs] Unhandled server error on action=' + action + ':', err);
    return out_({ ok: false, code: 'server_error', msg: 'Internal server error' });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (x) {}
    }
  }
}

// --- أدوات مساعدة ---
function num_(v) {
  return parseInt(String(v == null ? '' : v).replace(/\D/g, ''), 10) || 0;
}

function sid_(n) {
  return 'CBM-' + String(n).padStart(6, '0');
}

// --- عدّادات معدّل بنافذة ثابتة (لا يتجدد وقت الانتهاء مع كل طلب) ---
function rlRead_(cache, key) {
  const raw = cache.get(key);
  if (!raw) return { n: 0, t: Date.now() };
  const p = String(raw).split('|');
  const n = parseInt(p[0], 10) || 0;
  const t = parseInt(p[1], 10) || Date.now();
  if (Date.now() - t >= RATE_LIMIT_WINDOW_SEC * 1000) return { n: 0, t: Date.now() };
  return { n: n, t: t };
}

function rlCount_(cache, key) {
  return rlRead_(cache, key).n;
}

function rlHit_(cache, key) {
  const st = rlRead_(cache, key);
  st.n += 1;
  const remain = Math.max(1, Math.ceil(RATE_LIMIT_WINDOW_SEC - (Date.now() - st.t) / 1000));
  cache.put(key, st.n + '|' + st.t, Math.min(remain, 21600));
  return st.n;
}

function sanitizeKeyPart_(s, maxLen) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, maxLen || 48) || 'anon';
}

/**
 * تطهير الاسم من المسافات الزائدة ومن بادئات حقن المعادلات (= + - @ ' " Tab CR LF)
 * لمنع Formula Injection في Google Sheets عند استخدام appendRow.
 */
function cleanName_(s) {
  return String(s == null ? '' : s)
    .replace(/^[\s=+\-@'"\t\r\n]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normName_(s) {
  return cleanName_(s)
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

/**
 * تقنيع الاسم لحماية الخصوصية عند مسح QR: يظهر أول حرف من كل كلمة متبوعاً بـ ***
 */
function maskName_(fullName) {
  const cleaned = cleanName_(fullName);
  if (!cleaned) return '***';
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map(function(word) { return Array.from(word)[0] + '***'; })
    .join(' ');
}

/**
 * التحقق من أن رابط Web Push ينتمي لخدمة إشعارات رسمية معتمدة، وأن مفاتيح التشفير صالحة.
 */
function isValidPushSubscription_(endpoint, p256dh, auth) {
  const ep = String(endpoint || '').trim();
  if (!/^https:\/\//i.test(ep) || ep.length > 1024) return false;

  const m = ep.match(/^https:\/\/([^/:?#]+)(?:\/.*)?$/i);
  if (!m) return false;
  const host = m[1].toLowerCase();

  let hostAllowed = ALLOWED_PUSH_HOSTS.indexOf(host) >= 0;
  if (!hostAllowed) {
    for (let i = 0; i < ALLOWED_PUSH_SUFFIXES.length; i++) {
      const sfx = ALLOWED_PUSH_SUFFIXES[i];
      if (host.length > sfx.length && host.slice(-sfx.length) === sfx) {
        hostAllowed = true;
        break;
      }
    }
  }
  if (!hostAllowed) return false;

  // التحقق من مفاتيح التشفير بصيغة base64url
  if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(String(p256dh || ''))) return false;
  if (!/^[A-Za-z0-9_-]{20,32}={0,2}$/.test(String(auth || ''))) return false;
  return true;
}

function generateUniqueRandomNo_(usedSet) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const uuid = Utilities.getUuid().replace(/-/g, '');
    const chunk = parseInt(uuid.slice(0, 8), 16);
    const rand = Math.floor(Math.random() * 900000);
    const candidate = 100000 + ((chunk ^ rand) % 900000 + 900000) % 900000;
    if (!usedSet[candidate]) {
      return candidate;
    }
  }
  let fallback = 100000 + Math.floor(Math.random() * 899999);
  while (usedSet[fallback]) fallback = ((fallback - 99999) % 900000) + 100000;
  return fallback;
}

function rowStatus_(r) {
  const raw = String(r[5] || '').trim().toLowerCase();
  if (raw === 'revoked' || raw === 'ملغاة' || raw === 'ملغى') return 'revoked';
  if (raw === 'inactive' || raw === 'غير نشط') return 'inactive';
  return 'active';
}

function rowIso_(r) {
  try {
    const d = r[0] ? new Date(r[0]) : new Date();
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch (e) {
    return new Date().toISOString();
  }
}

function fullCardObj_(r) {
  const no = num_(r[1]);
  const iso = rowIso_(r);
  const status = rowStatus_(r);
  return {
    ok: true,
    no: no,
    supporterId: sid_(no),
    serialNumber: sid_(no),
    name: cleanName_(r[2]),
    status: status,
    createdAt: iso
  };
}

function publicVerifyObj_(r) {
  const no = num_(r[1]);
  const iso = rowIso_(r);
  const status = rowStatus_(r);
  const masked = maskName_(r[2]);
  if (status !== 'active') {
    return {
      ok: false,
      code: status,
      supporterId: sid_(no),
      maskedName: masked,
      status: status,
      createdAt: iso
    };
  }
  return {
    ok: true,
    supporterId: sid_(no),
    serialNumber: sid_(no),
    maskedName: masked,
    status: 'active',
    createdAt: iso
  };
}

// --- المعالج الرئيسي للطلبات ---
function handle_(q, method) {
  const ver = q.v || 2;
  if (ver !== 1 && ver !== 2) return { ok: false, code: 'bad' };

  const action = String(q.a || 'verify').trim().toLowerCase();

  if (method === 'GET' && (action !== 'verify' || q.key)) {
    return { ok: false, code: 'method_not_allowed' };
  }

  // Public, read-only match-control state. It exposes only the live match ID and scoreboard.
  // Telegram mutations are accepted only through the secret webhook and the allow-listed admin ID.
  if (method === 'POST' && action === 'live_state') {
    return { ok: true, state: publicLiveControlState_() };
  }

  const sheet = sheet_();
  const lastRow = sheet.getLastRow();
  const n = Math.max(0, lastRow - 1);
  const rows = n ? sheet.getRange(2, 1, n, 7).getValues() : [];

  // 1) التحقق العام من صلاحية البطاقة (قراءة فقط بدون قفل، يرجع الاسم مقنّعاً فقط)
  if (action === 'verify') {
    const targetNo = num_(q.supporterId || q.no || q.n || q.q);
    if (!targetNo) return { ok: false, code: 'not_found' };

    const vCache = CacheService.getScriptCache();
    const vDev = sanitizeKeyPart_(q.dev || 'anon', 48);
    const vDevKey = 'RL_VERIFY_DEV_' + vDev;
    if (
      rlCount_(vCache, 'RL_VERIFY_GLOBAL') >= VERIFY_MAX_GLOBAL ||
      (vDev !== 'anon' && rlCount_(vCache, vDevKey) >= VERIFY_MAX_PER_DEV)
    ) {
      return { ok: false, code: 'rate_limit', retryAfterMinutes: 15 };
    }
    rlHit_(vCache, 'RL_VERIFY_GLOBAL');
    if (vDev !== 'anon') rlHit_(vCache, vDevKey);

    const r = rows.find(function(x) { return num_(x[1]) === targetNo; });
    if (!r) return { ok: false, code: 'not_found' };
    return publicVerifyObj_(r);
  }

  if (method !== 'POST') {
    return { ok: false, code: 'method_not_allowed' };
  }

  // 2) تسجيل بطاقة مناصر جديدة بمعرّف عشوائي CBM-XXXXXX
  if (action === 'register') {
    const name = cleanName_(q.name);
    if (name.length < 2 || name.length > 80) {
      return { ok: false, code: 'invalid_name' };
    }
    const targetNorm = normName_(name);
    const reqId = sanitizeKeyPart_(q.requestId || '', 64);
    const devId = sanitizeKeyPart_(q.dev || 'anon', 48);
    const cache = CacheService.getScriptCache();
    const regDevKey = 'RL_REG_DEV_' + devId;
    const regGlobalKey = 'RL_REG_GLOBAL';

    // (أ) إعادة المحاولة نفسها ترجع البطاقة الموجودة ولا تُحتسب ضمن الحد.
    //     لا يُرفض الاسم المكرر: الأسماء الشائعة مسموحة، وكل بطاقة لها رقم فريد.
    const usedNumbers = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rNo = num_(r[1]);
      if (rNo > 0) usedNumbers[rNo] = true;
      const rReq = String(r[3] || '').trim();
      const rDev = String(r[4] || '').trim();
      if (reqId && reqId !== 'anon' && rReq === reqId) {
        return fullCardObj_(r);
      }
      if (devId !== 'anon' && rDev === devId && normName_(r[2]) === targetNorm) {
        return fullCardObj_(r);
      }
    }

    // (ب) حدود التسجيل (بطاقات جديدة فقط)
    if (
      (devId !== 'anon' && rlCount_(cache, regDevKey) >= REGISTER_MAX_PER_DEV) ||
      rlCount_(cache, regGlobalKey) >= REGISTER_MAX_GLOBAL
    ) {
      return { ok: false, code: 'rate_limit', retryAfterMinutes: 15 };
    }
    rlHit_(cache, regDevKey);
    rlHit_(cache, regGlobalKey);

    const randomNo = generateUniqueRandomNo_(usedNumbers);
    const nowIso = new Date().toISOString();
    const lang = ['ar', 'fr', 'en'].indexOf(q.lang) >= 0 ? q.lang : 'ar';
    const newRow = [nowIso, sid_(randomNo), name, reqId, devId, 'active', lang];
    sheet.appendRow(newRow);
    return fullCardObj_(newRow);
  }

  // 3) استعادة بطاقة مناصر: حد لكل بطاقة ولكل جهاز، وصاحب الجهاز المسجّل لا يتأثر بالحدود
  if (action === 'restore') {
    const devKey = sanitizeKeyPart_(q.dev || 'anon', 48);
    const targetNo = num_(q.supporterId || q.no);
    const targetNorm = normName_(q.name);

    const cache = CacheService.getScriptCache();
    const rateDevKey = 'RL_RESTORE_DEV_' + devKey;
    const rateSidKey = 'RL_RESTORE_SID_' + String(targetNo || '0');
    const rateGlobalKey = 'RL_RESTORE_GLOBAL';

    const row = targetNo ? rows.find(function(x) { return num_(x[1]) === targetNo; }) : null;
    const isOwnerDevice = !!(row && devKey !== 'anon' && String(row[4] || '').trim() === devKey);

    if (!isOwnerDevice) {
      if (
        rlCount_(cache, rateDevKey) >= RESTORE_MAX_FAILS_PER_DEV ||
        (targetNo && rlCount_(cache, rateSidKey) >= RESTORE_MAX_FAILS_PER_SID)
      ) {
        return { ok: false, code: 'rate_limit', retryAfterMinutes: 15 };
      }
    }

    const matched = !!(row && targetNorm && normName_(row[2]) === targetNorm);
    if (!matched) {
      const dFails = rlHit_(cache, rateDevKey);
      const sFails = targetNo ? rlHit_(cache, rateSidKey) : 0;
      const gFails = rlHit_(cache, rateGlobalKey);
      if (gFails === RESTORE_WARN_GLOBAL) {
        console.warn('[CBM Security] ارتفاع فشل الاستعادة العام: ' + gFails + ' خلال النافذة الحالية');
      }
      if (!isOwnerDevice && (dFails >= RESTORE_MAX_FAILS_PER_DEV || sFails >= RESTORE_MAX_FAILS_PER_SID)) {
        return { ok: false, code: 'rate_limit', retryAfterMinutes: 15 };
      }
      return { ok: false, code: 'not_found' };
    }

    cache.remove(rateDevKey);
    cache.remove(rateSidKey);
    if (rowStatus_(row) === 'revoked') return { ok: false, code: 'revoked' };
    return fullCardObj_(row);
  }

  // 4) إجراء إداري: جلب المناصرين الجدد (POST + ADMIN_KEY)
  if (action === 'list') {
    const adminKey = getAdminKey_();
    if (!adminKey || String(q.key || '').trim() !== adminKey) {
      return { ok: false, code: 'denied' };
    }
    const props = PropertiesService.getScriptProperties();
    const lastAckRow = num_(props.getProperty('LAST_ACK_ROW') || 0);
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const r = rows[i];
      const rNo = num_(r[1]);
      if (rowNumber > lastAckRow && rNo > 0 && rowStatus_(r) !== 'revoked') {
        items.push({
          row: rowNumber,
          no: rNo,
          supporterId: sid_(rNo),
          name: cleanName_(r[2]),
          createdAt: rowIso_(r)
        });
      }
    }
    return { ok: true, total: rows.length, lastAck: lastAckRow, items: items };
  }

  // 5) إجراء إداري: تأكيد استلام قائمة المناصرين الجدد (POST + ADMIN_KEY)
  if (action === 'ack') {
    const adminKey = getAdminKey_();
    if (!adminKey || String(q.key || '').trim() !== adminKey) {
      return { ok: false, code: 'denied' };
    }
    const upTo = num_(q.upTo);
    const props = PropertiesService.getScriptProperties();
    const currentAck = num_(props.getProperty('LAST_ACK_ROW') || 0);
    const nextAck = Math.max(currentAck, upTo);
    props.setProperty('LAST_ACK_ROW', String(nextAck));
    return { ok: true, upTo: nextAck };
  }

  // 6) اشتراك إشعارات الهاتف الفورية (Web Push Subscribe - مع فحص النطاق والمفاتيح وسقف الجدول)
  if (action === 'push_sub') {
    const sub = q.sub || {};
    const endpoint = String(sub.endpoint || '').trim();
    const keys = sub.keys || {};
    const p256dh = String(keys.p256dh || '').trim();
    const auth = String(keys.auth || '').trim();
    const devId = sanitizeKeyPart_(q.dev || 'anon', 64);
    const lang = ['ar', 'fr', 'en'].indexOf(q.lang) >= 0 ? q.lang : 'ar';

    if (!isValidPushSubscription_(endpoint, p256dh, auth)) {
      return { ok: false, code: 'invalid_subscription' };
    }

    const ps = pushSheet_();
    const pLast = ps.getLastRow();
    const pCount = Math.max(0, pLast - 1);
    const pRows = pCount ? ps.getRange(2, 1, pCount, 7).getValues() : [];
    const nowIso = new Date().toISOString();

    let reusableRowIndex = -1;
    let activeCount = 0;

    for (let i = 0; i < pRows.length; i++) {
      const rowEp = String(pRows[i][2] || '');
      const rowDev = String(pRows[i][1] || '');
      const rowState = String(pRows[i][6] || 'active').trim().toLowerCase();
      if (rowState === 'active') activeCount++;
      else if (reusableRowIndex < 0) reusableRowIndex = i + 2;

      if (rowEp === endpoint || (devId && devId !== 'anon' && rowDev === devId)) {
        ps.getRange(i + 2, 1, 1, 7).setValues([[nowIso, devId, endpoint, p256dh, auth, lang, 'active']]);
        return { ok: true, subscribed: true };
      }
    }

    if (reusableRowIndex > 0) {
      ps.getRange(reusableRowIndex, 1, 1, 7).setValues([[nowIso, devId, endpoint, p256dh, auth, lang, 'active']]);
      return { ok: true, subscribed: true };
    }

    if (activeCount >= MAX_PUSH_SUBS) {
      return { ok: false, code: 'cap_reached' };
    }

    ps.appendRow([nowIso, devId, endpoint, p256dh, auth, lang, 'active']);
    return { ok: true, subscribed: true };
  }

  // 7) إلغاء اشتراك إشعارات الهاتف الفورية (Web Push Unsubscribe)
  if (action === 'push_unsub') {
    const endpoint = String((q.sub && q.sub.endpoint) || q.endpoint || '').trim();
    const devId = sanitizeKeyPart_(q.dev || '', 64);
    const ps = pushSheet_();
    const pLast = ps.getLastRow();
    const pCount = Math.max(0, pLast - 1);
    const pRows = pCount ? ps.getRange(2, 1, pCount, 7).getValues() : [];
    for (let i = 0; i < pRows.length; i++) {
      if ((endpoint && String(pRows[i][2]) === endpoint) || (devId && devId !== 'anon' && String(pRows[i][1]) === devId)) {
        ps.getRange(i + 2, 7).setValue('unsubscribed');
      }
    }
    return { ok: true, subscribed: false };
  }

  // 8) إجراء إداري: جلب اشتراكات الإشعارات النشطة (POST + ADMIN_KEY)
  if (action === 'push_list') {
    const adminKey = getAdminKey_();
    if (!adminKey || String(q.key || '').trim() !== adminKey) {
      return { ok: false, code: 'denied' };
    }
    const ps = pushSheet_();
    const pLast = ps.getLastRow();
    const pCount = Math.max(0, pLast - 1);
    const pRows = pCount ? ps.getRange(2, 1, pCount, 7).getValues() : [];
    const subs = [];
    for (let i = 0; i < pRows.length; i++) {
      const r = pRows[i];
      const ep = String(r[2] || '').trim();
      const kP256 = String(r[3] || '').trim();
      const kAuth = String(r[4] || '').trim();
      if (
        String(r[6] || 'active').trim().toLowerCase() === 'active' &&
        isValidPushSubscription_(ep, kP256, kAuth)
      ) {
        subs.push({
          endpoint: ep,
          keys: { p256dh: kP256, auth: kAuth },
          lang: String(r[5] || 'ar').trim()
        });
      }
    }
    return { ok: true, total: subs.length, items: subs };
  }

  // 9) إجراء إداري: تعطيل الاشتراكات المنتهية الصلاحية 404/410 (POST + ADMIN_KEY)
  if (action === 'push_prune') {
    const adminKey = getAdminKey_();
    if (!adminKey || String(q.key || '').trim() !== adminKey) {
      return { ok: false, code: 'denied' };
    }
    const dead = q.endpoints || [];
    const deadMap = {};
    for (let i = 0; i < dead.length; i++) deadMap[String(dead[i])] = true;
    const ps = pushSheet_();
    const pLast = ps.getLastRow();
    const pCount = Math.max(0, pLast - 1);
    const pRows = pCount ? ps.getRange(2, 1, pCount, 7).getValues() : [];
    let pruned = 0;
    for (let i = 0; i < pRows.length; i++) {
      if (deadMap[String(pRows[i][2])]) {
        ps.getRange(i + 2, 7).setValue('expired');
        pruned++;
      }
    }
    return { ok: true, pruned: pruned };
  }

  return { ok: false, code: 'bad' };
}

function sheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  const expectedHeaders = ['Timestamp', 'SupporterId', 'Name', 'RequestId', 'DeviceId', 'Status', 'Lang'];
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(expectedHeaders);
  } else if (sheet.getLastRow() >= 1) {
    const hdr = sheet.getRange(1, 1, 1, 7).getValues()[0];
    if (String(hdr[3]).indexOf('NIN') >= 0 || String(hdr[4]).indexOf('Phone') >= 0) {
      sheet.getRange(1, 1, 1, 7).setValues([expectedHeaders]);
    }
  }
  return sheet;
}

function pushSheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName(PUSH_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PUSH_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'DeviceId', 'Endpoint', 'P256dh', 'Auth', 'Lang', 'Status']);
  }
  return sheet;
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function out_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
