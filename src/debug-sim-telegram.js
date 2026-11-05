/* Part 13 test 4 — simulated delayed attendance:
   22/09 Java class, attendance marked in QUMS on 24/09, checked again 25/09 & 26/09. */
process.env.DB_FILE = '/tmp/sim-' + Date.now() + '.json';
/* Simulation: deep-link connect + repeat — verifies student-name greeting, no email. */
process.env.DB_FILE = '/tmp/tg-' + Date.now() + '.json';
process.env.TELEGRAM_BOT_TOKEN = 'test:stub';
process.env.TELEGRAM_BOT_USERNAME = 'test_bot';

// Stub node-telegram-bot-api so no real API call happens; capture sends.
const sent = [];
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot() {
      return {
        sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return true; },
        onText: () => {},
        on: () => {},
      };
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('./db');
const telegram = require('./telegram');

(async () => {
  await db.init();
  const user = await db.createUser({ email: 'sim@example.com', passwordHash: 'x' });
  await db.updateUser(user.id, { studentName: 'TEST STUDENT' });
  const code = await db.telegramLinkCodeFor(user.id);
  telegram.initTelegram();

  const CHAT = 555000111;
  await telegram.handleDeepLink(CHAT, code, { log: () => {}, error: () => {} });
  await telegram.handleDeepLink(CHAT, code, { log: () => {}, error: () => {} }); // repeat -> Already Connected
  // /status must also show the name, never the email
  await telegram.handleStatus(CHAT, { log: () => {}, error: () => {} });

  sent.forEach((s, i) => console.log(`--- message ${i + 1} ---\n${s.text}\n`));
  const all = JSON.stringify(sent);
  console.log('VERDICT contains email:', all.includes('sim@example.com') ? 'FAIL' : 'PASS (no email)');
  console.log('VERDICT fresh greeting:', sent[0].text === '✅ Connected!\nHello TEST STUDENT 👋\nYou will now receive attendance updates here.' ? 'PASS' : 'FAIL');
  console.log('VERDICT repeat greeting:', sent[1].text === '✅ Already Connected!\nHello TEST STUDENT 👋\nYou will continue to receive attendance updates here.' ? 'PASS' : 'FAIL');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

const rows = [
  { id: 'A1', title: 'OOP Assignment', subject: 'Java', teacher: 'DEEPAK BHATT', type: 'Assignment', assignedYMD: '2026-09-22', deadlineYMD: '2026-09-25', source: 'state' },
];
