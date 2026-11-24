/**
 * أميرتي — bot.js
 * واتساب + Gemini 2.0 Flash
 * سرعة أقل من ثانية ⚡
 */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const fs   = require('fs');
const path = require('path');

// ══════════════════════════════════════════════
//  إعدادات — تضبطها من متغيرات Render
// ══════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';  // مطلوب
const BOT_PHONE      = (process.env.BOT_PHONE || '').replace(/\D/g, ''); // رقمك
const BOT_NAME       = process.env.BOT_NAME || 'أميرتي';
const AUTH_DIR       = path.join(__dirname, 'auth_info');

// ══════════════════════════════════════════════
//  Gemini Client
// ══════════════════════════════════════════════
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: `أنت "${BOT_NAME}"، مساعدة ذكية وسريعة على واتساب.
- ردودك قصيرة ومفيدة ومباشرة (3-4 جمل كحد أقصى)
- تخاطب المستخدم باسمه دائماً
- لا تذكر أعذاراً تقنية أبداً
- الردود بالعربية دائماً إلا إذا كتب بلغة ثانية
- لا تكرر نفسك`,
  generationConfig: {
    maxOutputTokens: 300,
    temperature: 0.7,
  },
});

// ══════════════════════════════════════════════
//  ذاكرة المحادثات — خفيفة بالرام
// ══════════════════════════════════════════════
const chatSessions = new Map(); // jid → Gemini chat session
const processedIds = new Set();

function getChat(jid) {
  if (!chatSessions.has(jid)) {
    chatSessions.set(jid, model.startChat({ history: [] }));
  }
  return chatSessions.get(jid);
}

// ══════════════════════════════════════════════
//  AI: Gemini 2.0 Flash
// ══════════════════════════════════════════════
async function askGemini(jid, senderName, message) {
  const chat   = getChat(jid);
  const prompt = `${senderName} يقول: ${message}`;
  const result = await chat.sendMessage(prompt);
  return result.response.text().trim();
}

// ══════════════════════════════════════════════
//  إعادة الاتصال
// ══════════════════════════════════════════════
let sock             = null;
let reconnectTimer   = null;
let reconnectCount   = 0;
let pairingRequested = false;

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectCount++;
  const wait = delayMs ?? Math.min(5000 * reconnectCount, 30000);
  console.log(`[NET] إعادة الاتصال خلال ${Math.round(wait / 1000)}s...`);
  reconnectTimer = setTimeout(startBot, wait);
}

// ══════════════════════════════════════════════
//  تشغيل البوت
// ══════════════════════════════════════════════
async function startBot() {
  try {
    if (sock) { try { sock.end(undefined); } catch {} sock = null; }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version = [2, 3000, 1015901307];
    try { const r = await fetchLatestBaileysVersion(); version = r.version; } catch {}

    sock = makeWASocket({
      version,
      auth:  state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory:       false,
      markOnlineOnConnect:   false,
      connectTimeoutMs:      60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs:   30000,
    });

    sock.ev.on('creds.update', saveCreds);

    // ── حالة الاتصال ──────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

      if (!sock.authState.creds.registered && connection === 'connecting' && !pairingRequested) {
        pairingRequested = true;
        try {
          if (!BOT_PHONE) {
            console.log('[ERR] أضف BOT_PHONE في متغيرات Render');
            return;
          }
          await new Promise(r => setTimeout(r, 3000));
          const code = await sock.requestPairingCode(BOT_PHONE);
          console.log('=================================');
          console.log('PAIRING CODE: ' + code);
          console.log('=================================');
        } catch (e) {
          console.log('[ERR] فشل طلب الكود: ' + e.message);
          pairingRequested = false;
        }
      }

      if (connection === 'open') {
        reconnectCount   = 0;
        pairingRequested = false;
        console.log('[OK] أميرتي متصلة وجاهزة ⚡ Gemini 2.0 Flash');
      }

      if (connection === 'close') {
        pairingRequested = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log('[CLOSE] انقطع — كود: ' + (code || '?'));
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          chatSessions.clear();
        }
        scheduleReconnect();
      }
    });

    // ── استقبال الرسائل ───────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          if (!msg?.message || processedIds.has(msg.key?.id)) continue;
          processedIds.add(msg.key?.id);
          if (processedIds.size > 300) {
            processedIds.delete(processedIds.values().next().value);
          }

          const jid = msg.key.remoteJid;
          if (!jid || jid === 'status@broadcast' || msg.key.fromMe) continue;

          const isGroup = jid.endsWith('@g.us');

          const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption || '';

          if (!body.trim()) continue;

          const senderName = msg.pushName || 'صديقي';

          // في الجروب يرد فقط لو ذكروا اسمه
          if (isGroup && !body.includes(BOT_NAME)) continue;

          console.log(`[MSG] ${senderName}: ${body}`);

          // أمر انسى
          if (body.replace(BOT_NAME, '').trim() === 'انسى') {
            chatSessions.delete(jid);
            await sock.sendMessage(jid, { text: '🧠 تم! نبدأ من جديد.' }, { quoted: msg });
            continue;
          }

          // ⚡ رد Gemini
          const reply = await askGemini(jid, senderName, body);
          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            console.log(`[SENT] ⚡ رد على ${senderName}`);
          }

        } catch (e) {
          console.log('[ERR] ' + e.message);
        }
      }
    });

  } catch (e) {
    console.log('[ERR] startBot: ' + e.message);
    scheduleReconnect(8000);
  }
}

module.exports = { startBot };
