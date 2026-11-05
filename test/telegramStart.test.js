/**
 * Telegram /start — exactly-once + single-poller + English-only copy tests.
 *
 *   node test/telegramStart.test.js
 *
 * Koi network / real bot token use NAHI hota: `node-telegram-bot-api` ko stub
 * kiya jaata hai (sends capture hote hain), DB tmp file me jaati hai aur polling
 * lock bhi tmp dir me. Real data/ folder touch nahi hota.
 *
 * Covers (issue: "same /start -> multiple responses"):
 *   T1  plain /start                       -> sirf 1 welcome (exact English copy)
 *   T1b wahi update dobara deliver         -> koi doosra reply nahi (dedupe)
 *   T2  fresh valid deep-link              -> sirf 1 "Connected!" + student naam
 *   T3  same valid deep-link dobara        -> "Already Connected!" (invalid NAHI)
 *   T3b wahi deep-link update dobara       -> silently ignore
 *   T4  random invalid code                -> sirf 1 "invalid or expired"
 *   T5  initTelegram() dobara              -> koi extra handler/polling nahi
 *   T5b polling lock                       -> is pid ka record
 *   T5c doosra process (lock held)         -> polling SKIPPED + send-only
 *   T5d TELEGRAM_POLLING=off               -> koi polling nahi (sends chalte hain)
 *   T6  multi-user isolation               -> chat A -> user A, chat B -> user B
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Child processes (T5c/T5d) ko SAME tmp dir + lock file chahiye — isliye
// inherited env ko respect karte hain, sirf pehli baar (parent) me create.
const TMP_DIR = process.env.TELEGRAM_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'qums-tg-start-'));
process.env.TELEGRAM_TEST_TMP = TMP_DIR;
process.env.DB_FILE = process.env.DB_FILE || path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = ''; // .env ka DATABASE_URL override -> JSON store (test isolation)
process.env.TELEGRAM_POLLING_LOCK = process.env.TELEGRAM_POLLING_LOCK || path.join(TMP_DIR, 'telegram-polling.lock');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test:stub';
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'test_bot';

// ---- stub node-telegram-bot-api: koi getUpdates/HTTP nahi, sends capture ----
const sent = []; // { chatId, text }
const handlers = []; // { regexp, callback }
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot(token, options) {
      const b = {
        token,
        options: options || {},
        pollingCalls: 0,
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
          return true;
        },
        onText: (regexp, callback) => handlers.push({ regexp, callback }),
        on: () => {},
        clearTextListeners: () => {
          handlers.length = 0;
        },
        startPolling: () => {
          b.pollingCalls += 1;
        },
      };
      return b;
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const telegram = require('../src/telegram');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!pass) failures += 1;
}

const logs = [];
const quiet = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
const settle = () => new Promise((r) => setTimeout(r, 30));
const lastSent = () => sent[sent.length - 1] || { text: null };

/** Registered /start handler se ek fake Telegram update "deliver" karo. */
function deliver(chatId, text, messageId) {
  const matched = handlers.filter((h) => h.regexp.test(text));
  if (matched.length !== 1) {
    throw new Error(`expected exactly 1 registered handler for "${text}", got ${matched.length}`);
  }
  matched[0].callback({ chat: { id: chatId }, message_id: messageId, text }, text.match(matched[0].regexp));
}

// ---- child process mode: "doosra instance" simulate karo (lock parent ke paas) ----
if (process.argv[2] === '--second-instance') {
  const print = (m) => console.log(String(m)); // log + error dono stdout -> parent capture kar sake
  telegram.initTelegram({ log: print, error: print });
  console.log(`CHILD_OK polling_env=${process.env.TELEGRAM_POLLING || 'on'} handlers=${handlers.length}`);
  process.exit(0);
}

// ============================== MAIN ==============================
(async () => {
  await db.init();

  const userA = await db.createUser({ email: 'a@example.com', passwordHash: 'x' });
  await db.updateUser(userA.id, { studentName: 'TEST STUDENT' });
  const userB = await db.createUser({ email: 'b@example.com', passwordHash: 'x' });
  await db.updateUser(userB.id, { studentName: 'ASHA VERMA' });
  const codeA = await db.telegramLinkCodeFor(userA.id);
  const codeB = await db.telegramLinkCodeFor(userB.id);

  const CHAT_A = 900000001;
  const CHAT_B = 900000002;

  // require(telegram) ka koi side-effect nahi hona chahiye (koi polling/bot nahi)
  check('require(telegram) -> no bot/polling side effect', telegram.isReady(), false);

  // Spec: telegram.js ko server/scheduler/watcher/alerts/assignments sab import
  // karte hain — us import se koi extra polling/handler nahi banna chahiye.
  require('../src/alerts');
  require('../src/assignments');
  require('../src/scheduler');
  require('../src/watcher');
  check('imports (scheduler/watcher/alerts/assignments) -> koi bot side-effect nahi', telegram.isReady(), false);

  telegram.initTelegram(quiet);
  check('init: exactly ONE /start handler registered', handlers.filter((h) => h.regexp.test('/start')).length, 1);
  check(
    'init: /link + /status bhi exactly ek-ek',
    [handlers.filter((h) => h.regexp.test('/link')).length, handlers.filter((h) => h.regexp.test('/status')).length],
    [1, 1]
  );
  check('init: "polling armed" logged exactly once', logs.filter((l) => l.includes('polling armed')).length, 1);

  // ---- T1: plain /start -> sirf EK welcome (exact English copy) ----
  sent.length = 0;
  deliver(CHAT_A, '/start', 1001);
  await settle();
  check('T1 plain /start -> exactly 1 reply', sent.length, 1);
  check('T1 reply = exact English welcome', lastSent().text, telegram.MSG.WELCOME);
  check(
    'T1 koi legacy Hinglish copy nahi',
    /Dashboard kholo|Ye link invalid|bas itna hi/.test(String(lastSent().text)),
    false
  );

  // ---- T1b: wahi update dobara deliver -> silently ignore ----
  deliver(CHAT_A, '/start', 1001);
  await settle();
  check('T1b duplicate update -> 0 extra replies', sent.length, 1);

  // ---- T2: fresh valid deep-link -> sirf EK "Connected!" ----
  sent.length = 0;
  deliver(CHAT_A, `/start ${codeA}`, 1002);
  await settle();
  check('T2 valid deep-link -> exactly 1 reply', sent.length, 1);
  check(
    'T2 reply = exact connected copy (student name)',
    lastSent().text,
    '✅ Connected!\nHello TEST STUDENT 👋\nYou will now receive attendance updates here.'
  );
  check('T2 email Telegram pe nahi gaya', /a@example\.com/.test(String(lastSent().text)), false);
  check('T2 chat A -> user A linked', (await db.getUserByTelegramChatId(CHAT_A)).id, userA.id);


  // ---- T3: same valid deep-link dobara (naya update) -> "Already Connected!" ----
  sent.length = 0;
  deliver(CHAT_A, `/start ${codeA}`, 1003);
  await settle();
  check('T3 repeat valid deep-link -> exactly 1 reply', sent.length, 1);
  check(
    'T3 reply = "Already Connected!" (invalid NAHI)',
    lastSent().text,
    '✅ Already Connected!\nHello TEST STUDENT 👋\nYou will continue to receive attendance updates here.'
  );
  check('T3 koi invalid/expired reply NAHI', sent.some((s) => s.text === telegram.MSG.LINK_INVALID), false);

  // ---- T3b: wahi deep-link update dobara deliver -> silently ignore ----
  sent.length = 0;
  deliver(CHAT_A, `/start ${codeA}`, 1003);
  await settle();
  check('T3b duplicate deep-link update -> 0 extra replies', sent.length, 0);

  // ---- T4: genuinely random code -> sirf EK invalid message ----
  sent.length = 0;
  deliver(CHAT_A, '/start deadbeefdead', 1004);
  await settle();
  check('T4 random invalid code -> exactly 1 reply', sent.length, 1);
  check('T4 reply = exact invalid/expired copy', lastSent().text, telegram.MSG.LINK_INVALID);

  // ---- T6: multi-user isolation ----
  sent.length = 0;
  deliver(CHAT_B, `/start ${codeB}`, 1005);
  await settle();
  check('T6 chat B -> user B linked', (await db.getUserByTelegramChatId(CHAT_B)).id, userB.id);
  check(
    'T6 chat B greeting = user B ka naam',
    lastSent().text,
    '✅ Connected!\nHello ASHA VERMA 👋\nYou will now receive attendance updates here.'
  );
  check('T6 chat A ab bhi user A', (await db.getUserByTelegramChatId(CHAT_A)).id, userA.id);

  // ---- T5: initTelegram dobara -> koi extra handler/polling nahi ----
  const armedBefore = logs.filter((l) => l.includes('polling armed')).length;
  telegram.initTelegram(quiet);
  telegram.initTelegram(quiet);
  check('T5 re-init -> handlers waise hi (3)', handlers.length, 3);
  check('T5 re-init -> "polling armed" dobara log nahi hua', logs.filter((l) => l.includes('polling armed')).length, armedBefore);

  // ---- T5b: polling lock is pid ka hai ----
  const lock = JSON.parse(fs.readFileSync(process.env.TELEGRAM_POLLING_LOCK, 'utf8'));
  check('T5b polling lock = is process ka pid', lock.pid, process.pid);

  // ---- T5c: doosra process (lock parent ke paas) -> polling SKIPPED ----
  const out2 = execFileSync(process.execPath, [__filename, '--second-instance'], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check('T5c second instance -> koi "polling armed" nahi', /polling armed/.test(out2), false);
  check('T5c second instance -> SKIPPED warning', /polling SKIPPED/.test(out2), true);
  check('T5c second instance -> send-only bot (sends possible)', /send-only bot created/.test(out2), true);

  // ---- T5d: TELEGRAM_POLLING=off -> koi polling nahi (lock se nahi, env se) ----
  const out3 = execFileSync(process.execPath, [__filename, '--second-instance'], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_POLLING: 'off', TELEGRAM_POLLING_LOCK: path.join(TMP_DIR, 'off.lock') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check('T5d TELEGRAM_POLLING=off -> koi "polling armed" nahi', /polling armed/.test(out3), false);
  check('T5d TELEGRAM_POLLING=off -> explicitly logged', /TELEGRAM_POLLING=off/.test(out3), true);
  check('T5d TELEGRAM_POLLING=off -> lock conflict nahi (env switch kaam kiya)', /polling SKIPPED — pid/.test(out3), false);

  // ---- T7: linked user sends plain /start -> welcome back with name & commands ----
  sent.length = 0;
  deliver(CHAT_A, '/start', 1010);
  await settle();
  check('T7 linked /start -> 1 reply', sent.length, 1);
  check('T7 linked /start -> includes student name', lastSent().text.includes('TEST STUDENT'), true);
  check('T7 linked /start -> includes /attendance command', lastSent().text.includes('/attendance'), true);

  // ---- T8: /help -> shows commands ----
  sent.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: '/help', message_id: 1011 }, quiet);
  check('T8 /help -> 1 reply', sent.length, 1);
  check('T8 /help -> lists /today', lastSent().text.includes('/today'), true);

  // ---- T9: /status on linked chat -> shows status details ----
  sent.length = 0;
  deliver(CHAT_A, '/status', 1012);
  await settle();
  check('T9 /status -> 1 reply', sent.length, 1);
  check('T9 /status -> shows Account Status', lastSent().text.includes('Account Status') || lastSent().text.includes('Linked'), true);

  // ---- T10: text "hi" -> friendly greeting & commands ----
  sent.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: 'hi', message_id: 1013 }, quiet);
  check('T10 text "hi" -> 1 reply', sent.length, 1);
  check('T10 text "hi" -> contains commands', lastSent().text.includes('/attendance'), true);

  // ---- T11: /assignments -> lists assignments ----
  sent.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: '/assignments', message_id: 1014 }, quiet);
  check('T11 /assignments -> 1 reply', sent.length, 1);
  check('T11 /assignments -> mentions assignments', lastSent().text.includes('Assignments'), true);

  // ---- T12: /today -> returns schedule message ----
  sent.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: '/today', message_id: 1015 }, quiet);
  check('T12 /today -> 1 reply', sent.length, 1);
  check('T12 /today -> mentions today classes', lastSent().text.includes('Today\'s Classes'), true);

  // ---- T13: unknown command -> shows hint ----
  sent.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: '/unknowncmd', message_id: 1016 }, quiet);
  check('T13 unknown command -> 1 reply', sent.length, 1);
  check('T13 unknown command -> hints /help', lastSent().text.includes('/help'), true);

  console.log(failures === 0 ? '\nALL TELEGRAM /start TESTS PASSED' : `\n${failures} TELEGRAM /start TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('[x]', err.name || 'Error', '-', err.message);
  process.exit(1);
});
