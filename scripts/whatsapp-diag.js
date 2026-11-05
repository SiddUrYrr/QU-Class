/**
 * WhatsApp diagnostics — batata hai ki client kitni door tak chalta hai:
 *   [diag] puppeteer launched -> QR received -> (scan) -> READY
 * Temp auth dir use karta hai (.wwebjs_auth-diag) taaki tumhare running server
 * ka real session disturb na ho. 45s me exit.
 *
 *   node scripts/whatsapp-diag.js
 */
process.env.WA_AUTH_DIR = require('path').join(__dirname, '..', '.wwebjs_auth-diag');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WA_AUTH_DIR }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

const t0 = Date.now();
const ts = () => `+${Math.round((Date.now() - t0) / 100) / 10}s`;

client.on('qr', (qr) => {
  console.log(`[${ts()}] QR RECEIVED (puppeteer + WhatsApp flow working — scan needed for real link):`);
  qrcode.generate(qr, { small: true });
});
client.on('loading_screen', (pct) => console.log(`[${ts()}] loading ${pct}%`));
client.on('authenticated', () => console.log(`[${ts()}] authenticated`));
client.on('ready', () => {
  console.log(`[${ts()}] ✅ CLIENT READY — WhatsApp feature kaam karega!`);
  console.log('[diag] success. Ab is diag ka auth dir delete kar sakte ho.');
  setTimeout(() => process.exit(0), 1000);
});
client.on('auth_failure', (m) => console.log(`[${ts()}] ❌ AUTH_FAILURE: ${m}`));
client.on('disconnected', (r) => console.log(`[${ts()}] disconnected: ${r}`));

client.initialize().catch((err) => {
  console.error(`[${ts()}] ❌ INITIALIZE FAILED:`, err.message);
  console.error('stack head:', (err.stack || '').split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});

setTimeout(() => {
  console.log(`[${ts()}] (45s timeout — QR aaya par scan nahi hua to ye normal hai. READY aana chahiye tha scan ke baad.)`);
  process.exit(0);
}, 45000);
