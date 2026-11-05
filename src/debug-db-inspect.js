/** Inspect db.json — emails + setup status only (no secrets). */
const fs = require('fs');
const path = require('path');
const dbFile = path.join(__dirname, '..', 'data', 'db.json');
try {
  const raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const users = raw.users || [];
  console.log('total users:', users.length);
  users.forEach((u) => {
    console.log(
      `- ${u.email} | qid: ${u.qumsQid || '(none)'} | qumsSession: ${!!u.qumsSessionPath} | pwdEncrypted: ${!!u.qumsPasswordEncrypted} | telegram: ${u.telegramChatId || '(not linked)'}`
    );
  });
} catch (e) {
  console.log('db.json nahi mila ya invalid:', e.message);
}
