'use strict';

const { startBot } = require('./bot');
const http = require('http');

// بورت وهمي لإسكات Render
http.createServer((_, res) => res.end('OK')).listen(process.env.PORT || 3000);

console.log('[SERVER] أميرتي v3 — Gemini 2.0 Flash ⚡');
startBot();
