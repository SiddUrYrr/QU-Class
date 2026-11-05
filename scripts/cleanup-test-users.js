/** One-off cleanup: remove example.com test users from db.json. */
const fs = require('fs');
const path = require('path');
const dbFile = path.join(__dirname, '..', 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const before = db.users.length;
db.users = (db.users || []).filter((u) => !/example\.com$/i.test(u.email || ''));
fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
console.log('users:', before, '->', db.users.length);
db.users.forEach((u) => console.log(' -', u.email));
