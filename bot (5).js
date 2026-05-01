'use strict';

// ============================================================================
//  GLOBAL CRASH GUARD — cegah Railway crash akibat unhandled error
// ============================================================================
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [UNCAUGHT EXCEPTION] ${err.stack || err.message}`);
  // Jangan exit — biarkan proses tetap hidup
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] [UNHANDLED REJECTION] ${reason?.stack || reason}`);
  // Jangan exit
});

/**
 * DAC Inception - Daily Multi-Wallet Bot (Telegram Edition)
 * https://inception.dachain.io/activity
 *
 * Chain : DAC Quantum Chain (ID: 21894)
 * RPC   : https://rpctest.dachain.tech
 *
 * Environment variables (set di Railway):
 *
 *   TELEGRAM_TOKEN     token bot Telegram dari @BotFather (WAJIB)
 *   DISCORD_TOKEN      user token Discord untuk fetch alamat (WAJIB)
 *   DISCORD_CHANNEL_ID id channel Discord (default: 1495114103193210950)
 *
 *   PARALLEL           jumlah wallet yang jalan bersamaan (default: 5)
 *   DAILY_TX           target TX per hari per wallet (default: 50)
 *   LOOP_MINUTES       interval loop dalam menit (default: 10)
 *   BURN_AMOUNT        DAC dibakar per siklus (default: 0.005)
 *   PORT               port ping server (default: 3000)
 *   DATA_DIR           direktori penyimpanan data persistent (default: /data jika ada, fallback __dirname)
 *
 *   (Proxy tidak lagi dari file. Input langsung via Telegram bot tombol "Kelola Proxy")
 *
 * CATATAN:
 *   - Private key tidak lagi dari env. Semua diinput via Telegram bot.
 *   - Proxy diinput via Telegram bot (tombol "Kelola Proxy"), disimpan di sessions.json
 *   - Alamat tujuan TX diambil random dari Discord channel
 *   - sessions.json disimpan di DATA_DIR — pasang Railway Volume di /data agar persist
 */

const { ethers }          = require('ethers');
const axios               = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const http                = require('http');
const fs                  = require('fs');
const path                = require('path');
const TelegramBot         = require('node-telegram-bot-api');

// ============================================================================
//  PING SERVER  (supaya Railway free tier tidak sleep)
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bot is running');
}).listen(PORT, () => log('info', '', `Ping server listening on port ${PORT}`));

// ============================================================================
//  CONFIG
// ============================================================================

// DATA_DIR: gunakan /data (Railway Volume) kalau ada, fallback ke __dirname
function resolveDataDir() {
  const envDir = process.env.DATA_DIR;
  if (envDir) {
    try {
      if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });
      return envDir;
    } catch (_) {}
  }
  // Auto-detect: kalau /data bisa ditulis, pakai itu
  try {
    if (!fs.existsSync('/data')) fs.mkdirSync('/data', { recursive: true });
    fs.accessSync('/data', fs.constants.W_OK);
    return '/data';
  } catch (_) {}
  return __dirname;
}

const DATA_DIR      = resolveDataDir();
const STATE_FILE    = path.join(DATA_DIR, 'state.json');
const LOG_FILE      = path.join(DATA_DIR, 'bot.log');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const OWNER_CHAT_ID      = 6469077855;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_TOKEN     || '';
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN      || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1495114103193210950';

const CFG = {
  rpc:          'https://rpctest.dachain.tech',
  chainId:      21894,
  api:          'https://inception.dachain.io',
  qeContract:   '0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24',
  qeAbi:        ['function burnForQE() payable'],
  faucetCd:     24 * 60 * 60 * 1000,
  crateCd:      24 * 60 * 60 * 1000,
  sendAmount:   '0.001',
  txDelay:      3000,
  discordRefresh: 30 * 60 * 1000,
  rpcTimeout:   10000,   // timeout RPC per request (ms) — diperkecil agar gagal cepat
  rpcRetries:   2,       // jumlah retry RPC sebelum fallback ke direct
};

const LOOP_MINUTES = parseInt(process.env.LOOP_MINUTES || '10', 10);
const LOOP_MS      = LOOP_MINUTES * 60 * 1000;
const DAILY_TX     = parseInt(process.env.DAILY_TX     || '50', 10);
const BURN_AMOUNT  = process.env.BURN_AMOUNT            || '0.005';
const PARALLEL     = Math.min(parseInt(process.env.PARALLEL || '5', 10), 30);
// USE_PROXY otomatis aktif kalau proxyPool.list terisi (via Telegram)
function isProxyActive() { return proxyPool.list.length > 0; }

const CYCLES_PER_DAY = Math.floor((24 * 60) / LOOP_MINUTES);
const TX_PER_CYCLE   = Math.max(1, Math.ceil(DAILY_TX / CYCLES_PER_DAY));

// ============================================================================
//  LOGGER
// ============================================================================

function ts() {
  return new Date().toISOString();
}

function shortAddr(addr) {
  return addr ? addr.slice(0, 10) : '----------';
}

function log(level, addr, msg) {
  const line = `[${ts()}] [${shortAddr(addr)}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================================
//  GLOBAL RUNTIME STATE
// ============================================================================

let privateKeys      = [];       // private keys diinput via Telegram
let botRunning       = false;    // apakah bot loop sedang jalan
let botStopFlag      = false;    // signal untuk hentikan loop
let subscribers      = new Set();// chat ID yang /start bot (terima summary)
let dailySummary     = {};       // { addr: { txSent, faucetClaims, crateOpens, burns } }
let discordAddresses = [];       // ETH addresses hasil scrape Discord

// Session per user untuk input private key
// { chatId: { state, expectedCount, collectedKeys, currentIndex, addMode } }
const userSessions = {};

// ============================================================================
//  PERSISTENCE
// ============================================================================

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (Array.isArray(data.subscribers)) {
      subscribers = new Set(data.subscribers);
    }
    if (Array.isArray(data.privateKeys) && data.privateKeys.length > 0) {
      privateKeys = data.privateKeys;
      log('ok', '', `Loaded ${privateKeys.length} private key dari sessions.json`);
    }
    if (data.dailySummary && typeof data.dailySummary === 'object') {
      dailySummary = data.dailySummary;
    }
    if (Array.isArray(data.proxies) && data.proxies.length > 0) {
      proxyPool.list = data.proxies;
      log('ok', '', `Loaded ${proxyPool.list.length} proxy dari sessions.json`);
    }
    return !!data.botWasRunning;  // return apakah bot sedang running sebelum crash
  } catch (_) {
    log('info', '', 'sessions.json belum ada, mulai fresh');
    return false;
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
      subscribers:  [...subscribers],
      privateKeys,
      dailySummary,
      proxies:      proxyPool.list,
      botWasRunning: botRunning,   // simpan state running
    }, null, 2));
  } catch (e) {
    log('error', '', `Gagal save sessions: ${e.message}`);
  }
}

// ============================================================================
//  PROXY MANAGER  — diinput via Telegram bot
// ============================================================================

const proxyPool = { list: [] };

/**
 * Parse teks proxy (satu per baris) dan simpan ke proxyPool.
 * Format yang didukung: ip:port | http://ip:port | user:pass@host:port
 * Kembalikan jumlah proxy valid.
 */
function setProxyList(rawText) {
  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const parsed = lines.map(l => {
    if (l.startsWith('http://') || l.startsWith('https://')) return l;
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(l)) return `http://${l}`;
    if (l.includes('@')) return `http://${l}`;
    return null;
  }).filter(Boolean);

  // shuffle
  for (let i = parsed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [parsed[i], parsed[j]] = [parsed[j], parsed[i]];
  }

  proxyPool.list = parsed;
  return parsed.length;
}

function getProxyUrl(walletIndex) {
  if (!isProxyActive()) return null;
  return proxyPool.list[walletIndex % proxyPool.list.length];
}

function getNextProxyUrl(currentIndex) {
  if (!isProxyActive()) return null;
  return proxyPool.list[(currentIndex + 1) % proxyPool.list.length];
}

// ============================================================================
//  DISCORD ADDRESS SCRAPER
// ============================================================================

const ETH_REGEX = /0x[a-fA-F0-9]{40}/g;

async function fetchDiscordAddresses() {
  if (!DISCORD_TOKEN) {
    log('warn', '', 'DISCORD_TOKEN kosong — skip scrape Discord');
    return;
  }

  const found = new Set();
  let lastId  = null;

  log('info', '', 'Scraping ETH addresses dari Discord...');

  // Ambil hingga 5 batch x 100 pesan = 500 pesan
  for (let batch = 0; batch < 5; batch++) {
    try {
      let url = `https://discord.com/api/v9/channels/${DISCORD_CHANNEL_ID}/messages?limit=100`;
      if (lastId) url += `&before=${lastId}`;

      const r = await axios.get(url, {
        headers: {
          Authorization: DISCORD_TOKEN,
          'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept:        '*/*',
        },
        timeout: 15000,
      });

      const messages = r.data;
      if (!Array.isArray(messages) || messages.length === 0) break;

      for (const msg of messages) {
        const text = msg.content || '';
        const matches = text.match(ETH_REGEX) || [];
        for (const raw of matches) {
          try {
            found.add(ethers.getAddress(raw)); // normalize checksum
          } catch (_) {}
        }
      }

      lastId = messages[messages.length - 1]?.id;
      if (messages.length < 100) break;

      await sleep(800); // rate limit safety
    } catch (e) {
      const status = e.response?.status;
      if (status === 401) {
        log('error', '', 'DISCORD_TOKEN tidak valid atau expired (401)');
        break;
      }
      log('error', '', `Batch ${batch + 1} Discord error: ${status || e.message}`);
      break;
    }
  }

  if (found.size > 0) {
    discordAddresses = [...found];
    log('ok', '', `Discord addresses updated: ${discordAddresses.length} unique addresses`);
  } else {
    log('warn', '', 'Tidak ada ETH address ditemukan di Discord channel');
  }
}

function getRandomDiscordAddress() {
  if (discordAddresses.length === 0) return null;
  return discordAddresses[Math.floor(Math.random() * discordAddresses.length)];
}

// ============================================================================
//  STATE MANAGEMENT
// ============================================================================

const stateLock = { locked: false, queue: [] };

function acquireLock() {
  return new Promise(resolve => {
    if (!stateLock.locked) { stateLock.locked = true; resolve(); }
    else { stateLock.queue.push(resolve); }
  });
}

function releaseLock() {
  if (stateLock.queue.length > 0) stateLock.queue.shift()();
  else stateLock.locked = false;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getWalletState(all, addr) {
  if (!all[addr]) {
    all[addr] = {
      lastFaucet: 0, txCount: 0,
      txToday: 0, txDayStart: 0, crateOpens: 0, cycles: 0,
    };
  }
  return all[addr];
}

function resetDailyTxIfNeeded(st, now) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  if (st.txDayStart < dayStart.getTime()) {
    st.txToday    = 0;
    st.txDayStart = dayStart.getTime();
  }
}

async function saveWalletState(addr, st) {
  await acquireLock();
  try {
    const all = loadState();
    all[addr] = st;
    saveState(all);
  } finally { releaseLock(); }
}

// ============================================================================
//  HTTP CLIENT FACTORY
// ============================================================================

function createHttpClient(baseURL, proxyUrl) {
  const opts = { baseURL, timeout: 30000 };
  if (proxyUrl) {
    const agent    = new HttpsProxyAgent(proxyUrl);
    opts.httpAgent  = agent;
    opts.httpsAgent = agent;
    opts.proxy      = false;
  }
  return axios.create(opts);
}

/**
 * Buat provider ethers dengan retry otomatis untuk RPC 504/timeout.
 * Jika RPC gagal, akan retry sampai CFG.rpcRetries kali sebelum throw.
 */
function createProvider(proxyUrl, walletIndex = null) {
  let currentProxyUrl = proxyUrl;
  let fetchReq;
  let baseProvider;
  if (!proxyUrl) {
    baseProvider = new ethers.JsonRpcProvider(CFG.rpc, {
      chainId: CFG.chainId,
      name: 'dac',
    });
  } else {
    const agent    = new HttpsProxyAgent(proxyUrl);
    fetchReq = new ethers.FetchRequest(CFG.rpc);
    fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
    fetchReq.timeout = CFG.rpcTimeout;
    baseProvider = new ethers.JsonRpcProvider(fetchReq, {
      chainId: CFG.chainId,
      name: 'dac',
    });
  }

  // Wrap send() dengan retry logic untuk 504/timeout/TLS + proxy rotation
  const originalSend = baseProvider.send.bind(baseProvider);
  baseProvider.send = async function(method, params) {
    let lastErr;
    for (let attempt = 0; attempt < CFG.rpcRetries; attempt++) {
      try {
        return await originalSend(method, params);
      } catch (e) {
        lastErr = e;
        const msg = e.message || '';
        const isRetryable =
          msg.includes('504') ||
          msg.includes('502') ||
          msg.includes('503') ||
          msg.includes('Gateway Time-out') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('socket hang up') ||
          msg.includes('network error') ||
          msg.includes('timeout') ||
          msg.includes('disconnected before secure TLS connection') ||
          msg.includes('TLS connection was established') ||
          msg.includes('socket disconnected') ||
          msg.includes('ECONNABORTED') ||
          msg.includes('ERR_NETWORK');

        if (isRetryable) {
          // Proxy rotation: ganti proxy sebelum retry berikutnya
          if (isProxyActive() && walletIndex !== null && attempt < CFG.rpcRetries - 1) {
            const np = getNextProxyUrl(walletIndex + attempt);
            if (np && np !== currentProxyUrl) {
              currentProxyUrl = np;
              try {
                const newAgent = new HttpsProxyAgent(np);
                if (fetchReq) {
                  fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent: newAgent });
                }
                log('warn', '', `RPC ${method} rotate proxy → ${np}`);
              } catch (agentErr) {
                log('warn', '', `Gagal rotate proxy: ${agentErr.message}`);
              }
            }
          }

          if (attempt < CFG.rpcRetries - 1) {
            const wait = (attempt + 1) * 2000; // dipercepat: 2s, 4s
            log('warn', '', `RPC ${method} gagal (attempt ${attempt + 1}/${CFG.rpcRetries}): ${msg.slice(0, 80)} — retry dalam ${wait / 1000}s`);
            await sleep(wait);
            continue;
          }
        }
        throw e;
      }
    }

    // ── FALLBACK: semua proxy gagal → coba direct (tanpa proxy) ──
    if (proxyUrl) {
      try {
        log('warn', '', `RPC ${method} — semua proxy gagal, fallback ke direct RPC`);
        const directProvider = new ethers.JsonRpcProvider(CFG.rpc, { chainId: CFG.chainId, name: 'dac' });
        return await directProvider.send(method, params);
      } catch (directErr) {
        log('warn', '', `RPC ${method} direct juga gagal: ${(directErr.message || '').slice(0, 80)}`);
      }
    }

    throw lastErr;
  };

  return baseProvider;
}

// ============================================================================
//  API CLIENT
// ============================================================================

class ApiClient {
  constructor(wallet, proxyUrl) {
    this.wallet  = wallet;
    this.csrf    = '';
    this.cookies = '';
    this.http    = createHttpClient(CFG.api, proxyUrl);
  }

  _saveCookies(res) {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    for (const c of sc) {
      const [pair] = c.split(';');
      const [name] = pair.split('=');
      const re = new RegExp(`${name}=[^;]*`);
      this.cookies = re.test(this.cookies)
        ? this.cookies.replace(re, pair)
        : this.cookies + (this.cookies ? '; ' : '') + pair;
    }
  }

  _headers(post = false) {
    const h = { Cookie: this.cookies, Accept: 'application/json' };
    if (post) {
      h['Content-Type'] = 'application/json';
      h['X-CSRFToken']  = this.csrf;
      h['Origin']       = CFG.api;
    }
    return h;
  }

  async _fetchCsrf() {
    const r = await this.http.get('/csrf/', {
      headers: { Accept: 'application/json', Cookie: this.cookies },
    });
    this._saveCookies(r);
    const m = this.cookies.match(/csrftoken=([^;]+)/);
    if (m) this.csrf = m[1];
  }

  async init() {
    await this._fetchCsrf();
    const r = await this.http.post(
      '/api/auth/wallet/',
      { wallet_address: this.wallet.address.toLowerCase() },
      { headers: this._headers(true) }
    );
    this._saveCookies(r);
    await this._fetchCsrf();
    return r.data;
  }

  async _requestWithRetry(method, endpoint, body) {
    const doRequest = () => method === 'get'
      ? this.http.get(endpoint, { headers: this._headers() })
      : this.http.post(endpoint, body, { headers: this._headers(true) });

    const isRetryable = (e) => {
      const status = e.response?.status;
      const msg = e.message || '';
      return status === 502 || status === 503 || status === 504 ||
        msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
        msg.includes('socket hang up') || msg.includes('ECONNREFUSED');
    };

    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const r = await doRequest();
        this._saveCookies(r);
        return r.data;
      } catch (e) {
        const status = e.response?.status;

        // Auto re-auth kalau 401 (session expired)
        if (status === 401) {
          try {
            await this.init();
            const r2 = await doRequest();
            this._saveCookies(r2);
            return r2.data;
          } catch (e2) {
            throw e2;
          }
        }

        // Retry kalau 502/503/network error sementara
        if (isRetryable(e) && attempt < 2) {
          const wait = (attempt + 1) * 3000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        throw e;
      }
    }
  }

  async get(endpoint) {
    return this._requestWithRetry('get', endpoint);
  }

  async post(endpoint, body = {}) {
    return this._requestWithRetry('post', endpoint, body);
  }

  profile()              { return this.get('/api/inception/profile/'); }
  faucetClaim()          { return this.post('/api/inception/faucet/'); }
  faucetHistory()        { return this.get('/api/inception/faucet-history/'); }
  faucetStatus(id)       { return this.get(`/api/inception/faucet/status/${id}/`); }
  crateOpen()            { return this.post('/api/inception/crate/open/', {}); }
  crateHistory()         { return this.get('/api/inception/crate/history/'); }
  confirmBurn(h)         { return this.post('/api/inception/exchange/confirm-burn/', { tx_hash: h }); }
  sync(h)                { return this.post('/api/inception/sync/', { tx_hash: h || '0x' }); }
}

// ============================================================================
//  DAILY SUMMARY TRACKER
// ============================================================================

function initSummary(addr) {
  if (!dailySummary[addr]) {
    dailySummary[addr] = { txSent: 0, faucetClaims: 0, crateOpens: 0, burns: 0 };
  }
}

function buildSummaryText() {
  const dateStr  = new Date().toISOString().split('T')[0];
  const entries  = Object.entries(dailySummary);

  if (entries.length === 0) {
    return `📊 *Daily Summary — ${dateStr}*\n\n_Belum ada aktivitas hari ini._`;
  }

  let totalTx = 0, totalFaucet = 0, totalCrate = 0, totalBurn = 0;
  const walletLines = entries.map(([addr, s]) => {
    totalTx     += s.txSent;
    totalFaucet += s.faucetClaims;
    totalCrate  += s.crateOpens;
    totalBurn   += s.burns;
    return (
      `\`${addr.slice(0, 6)}...${addr.slice(-4)}\`\n` +
      `  📤 TX: *${s.txSent}*  🚿 Faucet: *${s.faucetClaims}*  📦 Crate: *${s.crateOpens}*  🔥 Burn: *${s.burns}*`
    );
  });

  return [
    `📊 *Daily Summary — ${dateStr}*`,
    `💼 *${entries.length} wallet aktif*\n`,
    ...walletLines,
    `\n📈 *Total Hari Ini*`,
    `📤 TX: *${totalTx}*  🚿 Faucet: *${totalFaucet}*  📦 Crate: *${totalCrate}*  🔥 Burn: *${totalBurn}*`,
  ].join('\n');
}

async function broadcastDailySummary(bot) {
  const text = buildSummaryText();
  log('info', '', `Broadcast daily summary → ${subscribers.size} subscriber(s)`);

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      await sleep(200);
    } catch (e) {
      log('warn', '', `Gagal kirim summary ke ${chatId}: ${e.message}`);
    }
  }

  // Reset summary harian
  dailySummary = {};
  saveSessions();
}

function scheduleDailySummary(bot) {
  let lastSentDate = '';

  setInterval(async () => {
    const now = new Date();
    // Kirim summary tiap hari jam 23:59 UTC
    if (now.getUTCHours() === 23 && now.getUTCMinutes() === 59) {
      const today = now.toISOString().split('T')[0];
      if (lastSentDate !== today) {
        lastSentDate = today;
        await broadcastDailySummary(bot).catch(e =>
          log('error', '', `Daily summary error: ${e.message}`)
        );
      }
    }
  }, 60_000);
}

// ============================================================================
//  ACTIVITIES
// ============================================================================

async function claimFaucet(api, addr, st, now) {
  initSummary(addr);

  // Cek cooldown via profile API (lebih akurat daripada tracking lokal)
  try {
    const prof = await api.profile();
    const faucetAvailable = prof?.faucet_available;
    const cooldownSeconds = prof?.faucet_cooldown_seconds ?? prof?.faucet_seconds_left ?? null;

    // Debug: selalu log status faucet dari server
    log('info', addr,
      `Faucet status — available: ${faucetAvailable} | cooldown: ${cooldownSeconds}s` +
      ` | dacc: ${prof?.dacc_balance ?? 'n/a'}`
    );

    if (faucetAvailable === false) {
      if (cooldownSeconds !== null && cooldownSeconds > 0) {
        const h = Math.floor(cooldownSeconds / 3600);
        const m = Math.floor((cooldownSeconds % 3600) / 60);
        log('info', addr, `Faucet cooldown (server) — ${h}h ${m}m lagi`);
        return;
      }
      // faucet_available=false tapi cooldown=0/null → server mungkin sedang proses, tetap coba
      log('warn', addr, 'Faucet: available=false tapi cooldown tidak jelas, tetap coba claim...');
    } else if (faucetAvailable === null || faucetAvailable === undefined) {
      // Field tidak ada di response, langsung coba claim
      log('warn', addr, 'Faucet: field faucet_available tidak ada di profile, langsung coba claim');
    }
    // faucetAvailable === true → lanjut claim (fall through)
  } catch (e) {
    // Jika profile gagal, fallback ke tracking lokal
    const elapsed = now - st.lastFaucet;
    if (elapsed < CFG.faucetCd) {
      const h = Math.floor((CFG.faucetCd - elapsed) / 3_600_000);
      const m = Math.floor(((CFG.faucetCd - elapsed) % 3_600_000) / 60_000);
      log('info', addr, `Faucet cooldown (lokal fallback) — ${h}h ${m}m lagi`);
      return;
    }
    log('warn', addr, `Gagal cek faucet via profile: ${e.message} — tetap coba claim`);
  }

  try {
    const r = await api.faucetClaim();

    // Sukses: bisa success:true, tx_hash, dispense_id, atau queued:true
    const claimed = r?.success || r?.tx_hash || r?.dispense_id || r?.queued;
    if (claimed) {
      st.lastFaucet = now;
      dailySummary[addr].faucetClaims++;

      // Coba fetch amount dari faucet-history (cara yang benar)
      let amountStr = r.dacc_amount || r.amount || null;
      if (!amountStr) {
        try {
          await sleep(1500); // tunggu server proses
          if (r.dispense_id) {
            const statusR = await api.faucetStatus(r.dispense_id);
            amountStr = statusR?.amount || statusR?.dacc_amount || null;
          }
          if (!amountStr) {
            const hist = await api.faucetHistory();
            const entries = Array.isArray(hist) ? hist : (hist?.results || hist?.history || []);
            if (entries.length > 0) {
              const latest = entries[0];
              amountStr = latest?.amount || latest?.dacc_amount || latest?.value || null;
            }
          }
        } catch (_) {}
      }

      log('ok', addr, `Faucet claimed — amount: ${amountStr || 'n/a'}`);
    } else {
      log('warn', addr, `Faucet: ${r?.error || r?.reason || JSON.stringify(r)}`);
    }
  } catch (e) {
    const d = e.response?.data;
    if (d?.error?.includes('Link') || d?.error?.includes('activate')) {
      log('warn', addr, 'Faucet: link X atau Discord dulu di inception.dachain.io');
    } else if (d?.error?.includes('cooldown') || d?.error?.includes('wait')) {
      log('info', addr, `Faucet masih cooldown: ${d.error}`);
    } else {
      log('error', addr, `Faucet failed: ${d?.error || d?.reason || e.message}`);
    }
  }
}

async function openCrates(api, addr, st) {
  initSummary(addr);
  try {
    const history     = await api.crateHistory();
    const opensToday  = history.opens_today      || 0;
    const dailyLimit  = history.daily_open_limit || 5;
    const remaining   = Math.max(dailyLimit - opensToday, 0);

    if (remaining <= 0) {
      log('info', addr, `Crate: ${opensToday}/${dailyLimit} sudah dibuka hari ini`);
      return;
    }

    log('info', addr, `Crate: membuka ${remaining} crate (${opensToday}/${dailyLimit} sudah dibuka)`);

    for (let i = 0; i < remaining; i++) {
      if (botStopFlag) break;
      const r = await api.crateOpen();
      if (!r?.success) {
        log('warn', addr, `Crate ${i + 1}: ${r?.error || JSON.stringify(r)}`);
        break;
      }
      st.crateOpens++;
      dailySummary[addr].crateOpens++;
      log('ok', addr,
        `Crate #${st.crateOpens} opened — reward: ${r.reward?.label || 'n/a'} (+${r.reward?.amount || 0} QE) | QE: ${r.new_total_qe}`
      );
      await sleep(1000);
    }
  } catch (e) {
    const d = e.response?.data;
    log('error', addr, `Crate failed: ${d?.error || e.message}`);
  }
}

async function sendTxs(signer, api, addr, st, now) {
  initSummary(addr);
  resetDailyTxIfNeeded(st, now);

  const remaining = DAILY_TX - st.txToday;
  if (remaining <= 0) {
    log('info', addr, `Daily TX tercapai (${st.txToday}/${DAILY_TX}) — skip`);
    return;
  }

  const toSend  = Math.min(TX_PER_CYCLE, remaining);

  let balance;
  try {
    balance = await signer.provider.getBalance(addr);
  } catch (e) {
    log('error', addr, `Gagal cek balance: ${e.message} — skip TX cycle ini`);
    return;
  }

  const sendWei = ethers.parseEther(CFG.sendAmount);
  const minWei  = sendWei + ethers.parseEther('0.001');

  if (balance < minWei) {
    log('warn', addr, `Balance rendah (${ethers.formatEther(balance)} DAC) — skip TX`);
    return;
  }

  log('info', addr, `TX siklus ini: ${toSend} | hari ini: ${st.txToday}/${DAILY_TX}`);

  let sent = 0;
  for (let i = 0; i < toSend; i++) {
    if (botStopFlag) break;

    // Kirim ke random address dari Discord, fallback ke self
    const toAddr = getRandomDiscordAddress() || addr;

    try {
      const tx = await signer.sendTransaction({ to: toAddr, value: sendWei });
      st.txCount++;
      st.txToday++;
      sent++;
      dailySummary[addr].txSent++;
      log('ok', addr,
        `TX #${st.txCount} → ${shortAddr(toAddr)} | ${tx.hash.slice(0, 20)} | ` +
        `${CFG.sendAmount} DAC | hari ini: ${st.txToday}/${DAILY_TX}`
      );
      await api.sync(tx.hash);
      if (i < toSend - 1) await sleep(CFG.txDelay);
    } catch (e) {
      log('error', addr, `TX failed: ${e.reason || e.message}`);
      break;
    }
  }

  if (sent > 0) {
    log('ok', addr, `${sent} TX terkirim | total hari ini: ${st.txToday}/${DAILY_TX}`);
  }
}

async function burnForQE(signer, api, addr) {
  initSummary(addr);

  let balance;
  try {
    balance = await signer.provider.getBalance(addr);
  } catch (e) {
    log('error', addr, `Gagal cek balance untuk burn: ${e.message} — skip`);
    return;
  }

  const burnWei = ethers.parseEther(BURN_AMOUNT);
  const needed  = burnWei + ethers.parseEther('0.001');

  if (balance < needed) {
    log('info', addr, `Burn skipped — butuh ${BURN_AMOUNT} DAC, punya ${ethers.formatEther(balance)} DAC`);
    return;
  }

  try {
    const contract = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx       = await contract.burnForQE({ value: burnWei });
    log('info', addr, `Burn submitted: ${tx.hash.slice(0, 20)}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      dailySummary[addr].burns++;
      log('ok', addr, `Burned ${BURN_AMOUNT} DAC → QE`);
      await api.confirmBurn(tx.hash);
      await api.sync(tx.hash);
    } else {
      log('warn', addr, 'Burn TX reverted');
    }
  } catch (e) {
    log('error', addr, `Burn failed: ${e.reason || e.message}`);
  }
}

// ============================================================================
//  WALLET CYCLE
// ============================================================================

async function runWallet(pk, walletIndex) {
  const wallet = new ethers.Wallet(pk);
  const addr   = wallet.address;
  const now    = Date.now();

  let proxyUrl = getProxyUrl(walletIndex);
  if (isProxyActive()) {
    log('info', addr, `Proxy: ${proxyUrl || 'tidak ada proxy tersedia'}`);
  }

  const provider = createProvider(proxyUrl, walletIndex);
  const signer   = wallet.connect(provider);
  const api      = new ApiClient(wallet, proxyUrl);

  const allState = loadState();
  const st       = getWalletState(allState, addr);

  log('info', addr, 'Authenticating...');
  let authOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const auth = await api.init();
      log('ok', addr, `Authenticated — QE: ${auth?.user?.qe_balance ?? 'n/a'}`);
      authOk = true;
      break;
    } catch (e) {
      if (isProxyActive() && attempt < 2) {
        const np = getNextProxyUrl(walletIndex + attempt);
        log('warn', addr, `Auth gagal (attempt ${attempt + 1}/3), rotate proxy → ${np}`);
        api.http = createHttpClient(CFG.api, np);
      } else {
        log('error', addr, `Auth failed: ${e.message}`);
      }
    }
  }
  if (!authOk) return;

  try {
    const bal = await provider.getBalance(addr);
    log('info', addr, `Balance: ${ethers.formatEther(bal)} DAC`);
  } catch (_) {}

  await claimFaucet(api, addr, st, now);  await sleep(1000);
  await openCrates(api, addr, st);         await sleep(1000);
  await sendTxs(signer, api, addr, st, now); await sleep(1000);
  await burnForQE(signer, api, addr);    await sleep(1000);

  try { await api.sync(); } catch (_) {}

  try {
    const p = await api.profile();
    const dacc = p.dacc_balance ?? p.dacc ?? 'n/a';
    log('ok', addr,
      `Profile — QE: ${p.qe_balance ?? 'n/a'} | DACC: ${dacc} | Rank: #${p.user_rank ?? '?'}` +
      ` | Badges: ${p.badges?.length ?? p.badges_count ?? 0}` +
      ` | Streak: ${p.streak_days ?? 0}d | TX: ${p.tx_count ?? 0} | x${p.qe_multiplier ?? 1}`
    );
  } catch (_) {}

  st.cycles++;
  await saveWalletState(addr, st);
}

// ============================================================================
//  PARALLEL RUNNER
// ============================================================================

async function runParallel(tasks, limit) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try { await tasks[i](); }
      catch (e) { log('error', '', `Worker error task ${i + 1}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

async function runAll(keys) {
  const div = '='.repeat(55);
  console.log(`\n${div}\nMenjalankan ${keys.length} wallet | paralel: ${PARALLEL}\n${div}\n`);
  const t0 = Date.now();

  const tasks = keys.map((pk, i) => async () => {
    if (botStopFlag) return;
    console.log(`\n--- [Wallet ${i + 1}/${keys.length}] mulai ---`);
    try { await runWallet(pk, i); }
    catch (e) { log('error', '', `Fatal wallet ${i + 1}: ${e.message}`); }
    console.log(`--- [Wallet ${i + 1}/${keys.length}] selesai ---`);
  });

  await runParallel(tasks, PARALLEL);

  console.log(`\n${div}\nCycle selesai dalam ${((Date.now() - t0) / 1000).toFixed(1)}s\n${div}\n`);
}

// ============================================================================
//  TELEGRAM BOT
// ============================================================================

function ownerMenu(running) {
  return {
    inline_keyboard: running
      ? [
          [{ text: '⛔ Stop Bot',           callback_data: 'stop'        }],
          [{ text: '➕ Tambah Private Key', callback_data: 'add_keys'    }],
          [{ text: '🔀 Kelola Proxy',       callback_data: 'set_proxy'   }],
          [{ text: '🗑 Clear All Proxy',    callback_data: 'clear_proxy' }],
          [{ text: '📊 Lihat Summary',      callback_data: 'summary'     }],
        ]
      : [
          [{ text: '🚀 Start Bot',           callback_data: 'start_bot'   }],
          [{ text: '➕ Tambah Private Key',  callback_data: 'add_keys'    }],
          [{ text: '🔀 Kelola Proxy',        callback_data: 'set_proxy'   }],
          [{ text: '🗑 Clear All Proxy',     callback_data: 'clear_proxy' }],
          [{ text: '📊 Lihat Summary',       callback_data: 'summary'     }],
        ],
  };
}

function initTelegramBot() {
  if (!TELEGRAM_TOKEN) {
    console.error('[FATAL] TELEGRAM_TOKEN tidak diset! Set env variable ini di Railway.');
    process.exit(1);
  }

  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  // ── /start ──────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    // Daftarkan sebagai subscriber summary harian
    subscribers.add(chatId);
    saveSessions();

    if (chatId === OWNER_CHAT_ID) {
      if (privateKeys.length > 0) {
        // Sudah ada keys — tampilkan menu
        await bot.sendMessage(chatId,
          `👋 Selamat datang kembali!\n\n` +
          `🔑 *${privateKeys.length} private key* tersimpan\n` +
          `📡 Discord addresses: *${discordAddresses.length}*\n` +
          `Status: ${botRunning ? '🟢 *Running*' : '🔴 *Stopped*'}\n\n` +
          `Pilih aksi:`,
          { parse_mode: 'Markdown', reply_markup: ownerMenu(botRunning) }
        );
      } else {
        // Belum ada keys — mulai input flow
        userSessions[chatId] = { state: 'awaiting_count', addMode: false };
        await bot.sendMessage(chatId,
          `👋 Selamat datang di *DAC Inception Bot*! 🚀\n\n` +
          `Mau input berapa private key? _(maks 30)_`,
          { parse_mode: 'Markdown' }
        );
      }
    } else {
      // Subscriber biasa
      await bot.sendMessage(chatId,
        `👋 Hai! Kamu terdaftar sebagai subscriber.\n\n` +
        `Kamu akan menerima *daily summary* otomatis setiap hari dari bot ini 📊`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ── /status ──────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== OWNER_CHAT_ID) return;

    const state  = loadState();
    const addrs  = privateKeys.map(pk => {
      try { return new ethers.Wallet(pk).address; } catch (_) { return null; }
    }).filter(Boolean);

    let lines = [
      `📡 *Status Bot*`,
      `Status: ${botRunning ? '🟢 Running' : '🔴 Stopped'}`,
      `Wallet: *${privateKeys.length}*`,
      `Discord addrs: *${discordAddresses.length}*`,
      `Proxy: *${isProxyActive() ? proxyPool.list.length + ' proxies aktif' : 'nonaktif'}*`,
      `Subscribers: *${subscribers.size}*\n`,
      `📁 Data DIR: \`${DATA_DIR}\`\n`,
    ];

    for (const addr of addrs.slice(0, 10)) {
      const st = state[addr];
      if (st) {
        lines.push(`\`${addr.slice(0, 10)}...\` TX hari ini: *${st.txToday}/${DAILY_TX}*`);
      }
    }
    if (addrs.length > 10) lines.push(`_...dan ${addrs.length - 10} wallet lainnya_`);

    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // ── Pesan teks (untuk key input flow) ─────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text   = msg.text?.trim();
    if (!text || text.startsWith('/')) return;

    const session = userSessions[chatId];
    if (!session) return;

    // State: menunggu proxy list (paste semua sekaligus)
    if (session.state === 'awaiting_proxy') {
      const count = setProxyList(text);
      if (count === 0) {
        await bot.sendMessage(chatId,
          `❌ Tidak ada proxy valid ditemukan.\n\nFormat yang didukung (satu per baris):\n` +
          "`ip:port`\n`http://ip:port`\n`user:pass@host:port`",
          { parse_mode: 'Markdown' }
        );
        return;
      }
      saveSessions();
      delete userSessions[chatId];
      log('ok', '', `${count} proxy disimpan oleh owner via Telegram`);
      await bot.sendMessage(chatId,
        `✅ *${count} proxy* berhasil disimpan dan diaktifkan!\n\n` +
        `Proxy akan digunakan di cycle berikutnya.`,
        { parse_mode: 'Markdown', reply_markup: ownerMenu(botRunning) }
      );
      return;
    }

    // State: menunggu jumlah key
    if (session.state === 'awaiting_count') {
      const count = parseInt(text, 10);
      if (isNaN(count) || count < 1 || count > 30) {
        await bot.sendMessage(chatId, '❌ Masukkan angka antara *1–30*.', { parse_mode: 'Markdown' });
        return;
      }
      session.expectedCount = count;
      session.collectedKeys = [];
      session.currentIndex  = 1;
      session.state         = 'awaiting_key';
      await bot.sendMessage(chatId,
        `📝 Kirim *private key ke-1* dari ${count}:\n_(format: 0x... atau 64 hex tanpa 0x)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // State: menunggu key satu per satu
    if (session.state === 'awaiting_key') {
      const raw = text.trim();
      const pk  = raw.startsWith('0x') ? raw : `0x${raw}`;

      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        await bot.sendMessage(chatId,
          `❌ Format tidak valid. Private key harus 64 karakter hex.\nCoba lagi — kirim *private key ke-${session.currentIndex}*:`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try { new ethers.Wallet(pk); }
      catch (_) {
        await bot.sendMessage(chatId,
          `❌ Private key tidak valid. Kirim *private key ke-${session.currentIndex}*:`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      session.collectedKeys.push(pk);
      log('info', '', `Key ${session.currentIndex}/${session.expectedCount} diterima dari chatId ${chatId}`);

      if (session.currentIndex >= session.expectedCount) {
        // Semua key sudah terkumpul
        if (session.addMode) {
          privateKeys.push(...session.collectedKeys);
        } else {
          privateKeys = session.collectedKeys;
        }
        saveSessions();
        delete userSessions[chatId];

        await bot.sendMessage(chatId,
          `✅ *${session.collectedKeys.length} private key* berhasil disimpan!\n` +
          `Total wallet aktif: *${privateKeys.length}*\n\n` +
          `Tekan *Start Bot* untuk mulai:`,
          { parse_mode: 'Markdown', reply_markup: ownerMenu(botRunning) }
        );
      } else {
        session.currentIndex++;
        await bot.sendMessage(chatId,
          `✅ Key ${session.currentIndex - 1} tersimpan.\n` +
          `Kirim *private key ke-${session.currentIndex}* dari ${session.expectedCount}:`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }
  });

  // ── Callback queries (tombol) ─────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;

    await bot.answerCallbackQuery(query.id);

    if (chatId !== OWNER_CHAT_ID) {
      await bot.sendMessage(chatId, '❌ Kamu tidak punya akses untuk ini.');
      return;
    }

    // ─ START BOT ─
    if (data === 'start_bot') {
      if (privateKeys.length === 0) {
        await bot.sendMessage(chatId, '❌ Belum ada private key. Tambahkan dulu dengan tombol *Tambah Private Key*.', { parse_mode: 'Markdown' });
        return;
      }
      if (botRunning) {
        await bot.sendMessage(chatId, '⚠️ Bot sudah running.');
        return;
      }
      botRunning  = true;
      botStopFlag = false;

      await bot.sendMessage(chatId,
        `🚀 *Bot dimulai!*\n\n` +
        `💼 ${privateKeys.length} wallet aktif\n` +
        `🔄 Loop setiap ${LOOP_MINUTES} menit\n` +
        `📡 Discord scrape: ${discordAddresses.length} alamat\n` +
        `🔀 Proxy: ${isProxyActive() ? proxyPool.list.length + ' proxies' : 'nonaktif'}`,
        { parse_mode: 'Markdown', reply_markup: ownerMenu(true) }
      );

      // Jalankan bot loop di background
      runBotLoop(bot).catch(async (e) => {
        log('error', '', `Bot loop crash: ${e.message}`);
        botRunning = false;
        saveSessions();
        try {
          await bot.sendMessage(OWNER_CHAT_ID,
            `❌ *Bot error & berhenti!*\n\`${e.message}\``,
            { parse_mode: 'Markdown', reply_markup: ownerMenu(false) }
          );
        } catch (_) {}
      });
      return;
    }

    // ─ STOP BOT ─
    if (data === 'stop') {
      if (!botRunning) {
        await bot.sendMessage(chatId, '⚠️ Bot tidak sedang running.');
        return;
      }
      botStopFlag = true;
      botRunning  = false;
      saveSessions();
      await bot.sendMessage(chatId,
        `⛔ *Stop signal dikirim!*\nBot akan berhenti setelah cycle saat ini selesai...`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ─ ADD KEYS ─
    if (data === 'add_keys') {
      userSessions[chatId] = { state: 'awaiting_count', addMode: true };
      await bot.sendMessage(chatId,
        `➕ *Tambah Private Key*\n\nMau tambah berapa private key? _(maks 30 total)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ─ SUMMARY ─
    if (data === 'summary') {
      const text = buildSummaryText();
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      return;
    }

    // ─ SET PROXY ─
    if (data === 'set_proxy') {
      const current = proxyPool.list.length;
      userSessions[chatId] = { state: 'awaiting_proxy' };
      await bot.sendMessage(chatId,
        `🔀 *Kelola Proxy*\n\n` +
        `Proxy aktif sekarang: *${current}*\n\n` +
        `Paste semua proxy kamu dalam *satu pesan*, satu per baris:\n\n` +
        `Format yang didukung:\n` +
        `\`ip:port\`\n\`http://ip:port\`\n\`user:pass@host:port\`\n\n` +
        `_(Kirim proxy baru akan menggantikan semua proxy lama)_`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑 Hapus Semua Proxy', callback_data: 'clear_proxy' }],
              [{ text: '❌ Batal',             callback_data: 'cancel_proxy' }],
            ],
          },
        }
      );
      return;
    }

    // ─ CLEAR PROXY ─
    if (data === 'clear_proxy') {
      proxyPool.list = [];
      saveSessions();
      delete userSessions[chatId];
      log('ok', '', 'Semua proxy dihapus oleh owner');
      await bot.sendMessage(chatId,
        `🗑 *Semua proxy dihapus.*\nBot sekarang berjalan tanpa proxy.`,
        { parse_mode: 'Markdown', reply_markup: ownerMenu(botRunning) }
      );
      return;
    }

    // ─ CANCEL PROXY ─
    if (data === 'cancel_proxy') {
      delete userSessions[chatId];
      await bot.sendMessage(chatId, '↩️ Dibatalkan.', { reply_markup: ownerMenu(botRunning) });
      return;
    }
  });

  bot.on('polling_error', (err) => {
    log('error', '', `Telegram polling error: ${err.message}`);
    // Jangan crash — polling error ditangani di sini
  });

  log('ok', '', 'Telegram bot aktif dan siap menerima perintah');
  return bot;
}

// ============================================================================
//  BOT MAIN LOOP
// ============================================================================

async function runBotLoop(bot) {
  // Fetch Discord addresses sebelum mulai
  await fetchDiscordAddresses();

  // Refresh Discord addresses tiap 30 menit
  const discordTimer = setInterval(async () => {
    if (!botRunning) { clearInterval(discordTimer); return; }
    await fetchDiscordAddresses().catch(e =>
      log('error', '', `Discord refresh error: ${e.message}`)
    );
  }, CFG.discordRefresh);

  log('info', '', `Bot loop start — ${privateKeys.length} wallets, loop ${LOOP_MINUTES}m`);

  while (botRunning && !botStopFlag) {
    try {
      await runAll(privateKeys);
    } catch (e) {
      log('error', '', `runAll error (bot tetap jalan): ${e.message}`);
      // Jangan break loop — tunggu sebentar lalu lanjut cycle berikutnya
      await sleep(30_000);
    }
    saveSessions();

    if (!botRunning || botStopFlag) break;

    // Kirim status cycle ke owner
    try {
      const state = loadState();
      const addrs = privateKeys.map(pk => {
        try { return new ethers.Wallet(pk).address; } catch (_) { return null; }
      }).filter(Boolean);

      const lines = [
        `✅ *Cycle selesai!*`,
        `🕐 ${new Date().toISOString()}`,
        `📡 Discord addrs: ${discordAddresses.length}\n`,
      ];
      for (const addr of addrs.slice(0, 15)) {
        const st = state[addr];
        if (st) {
          lines.push(`\`${addr.slice(0, 10)}...\` TX: *${st.txToday}/${DAILY_TX}*`);
        }
      }
      if (addrs.length > 15) lines.push(`_...dan ${addrs.length - 15} wallet lainnya_`);
      lines.push(`\nNext cycle in *${LOOP_MINUTES} menit*`);

      await bot.sendMessage(OWNER_CHAT_ID, lines.join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: ownerMenu(true),
      });
    } catch (_) {}

    log('info', '', `Waiting ${LOOP_MINUTES} minutes until next cycle...`);
    await sleep(LOOP_MS);
  }

  clearInterval(discordTimer);
  botRunning  = false;
  botStopFlag = false;
  log('info', '', 'Bot loop selesai');

  try {
    await bot.sendMessage(OWNER_CHAT_ID,
      `🛑 *Bot telah berhenti sepenuhnya.*\n\nTekan Start untuk menjalankan kembali.`,
      { parse_mode: 'Markdown', reply_markup: ownerMenu(false) }
    );
  } catch (_) {}
}

// ============================================================================
//  MAIN
// ============================================================================

(async () => {
  console.log('\n======================================================');
  console.log('  DAC Inception Bot — Telegram Edition');
  console.log('  https://inception.dachain.io/activity');
  console.log('======================================================\n');

  log('info', '', `Data directory: ${DATA_DIR}`);
  log('info', '', `sessions.json : ${SESSIONS_FILE}`);

  // ── Fetch IP publik Railway (untuk didaftarkan ke IP auth ProxyScrape) ──
  let publicIp = 'tidak diketahui';
  try {
    const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
    publicIp = ipRes.data?.ip || 'tidak diketahui';
  } catch (_) {
    try {
      const ipRes2 = await axios.get('https://ifconfig.me/ip', { timeout: 8000 });
      publicIp = (ipRes2.data || '').trim() || 'tidak diketahui';
    } catch (_2) {}
  }
  log('info', '', `═══ IP PUBLIK SERVER (Railway): ${publicIp} ═══`);
  console.log(`\n  ► IP untuk ProxyScrape IP Auth: ${publicIp}\n`);

  // Load state tersimpan
  const wasRunning = loadSessions();

  // Inisialisasi Telegram bot
  const bot = initTelegramBot();

  // Jadwalkan daily summary
  scheduleDailySummary(bot);

  console.log(`\nTelegram Bot   : aktif`);
  console.log(`Owner Chat ID  : ${OWNER_CHAT_ID}`);
  console.log(`Wallet saved   : ${privateKeys.length}`);
  console.log(`Subscribers    : ${subscribers.size}`);
  console.log(`Proxy          : ${isProxyActive() ? `aktif (${proxyPool.list.length} proxies)` : 'nonaktif (input via Telegram)'}`);
  console.log(`Discord CH     : ${DISCORD_CHANNEL_ID}`);
  console.log(`Data DIR       : ${DATA_DIR}\n`);

  // Auto-start kalau sebelumnya sedang running (recovery dari crash/restart)
  if (wasRunning && privateKeys.length > 0) {
    log('ok', '', '🔄 Auto-resume: bot was running sebelum restart — lanjut otomatis');
    botRunning  = true;
    botStopFlag = false;

    // Notif ke owner
    try {
      await bot.sendMessage(OWNER_CHAT_ID,
        `🔄 *Bot auto-resume setelah restart!*\n\n` +
        `📡 IP Publik: \`${publicIp}\`\n` +
        `👛 ${privateKeys.length} wallet | 🔀 ${proxyPool.list.length} proxy\n` +
        `📁 Data: \`${DATA_DIR}\`\n\n` +
        `_Bot langsung lanjut running tanpa perlu Start manual._`,
        { parse_mode: 'Markdown', reply_markup: ownerMenu(true) }
      );
    } catch (_) {}

    runBotLoop(bot).catch(async (e) => {
      log('error', '', `Bot loop crash: ${e.message}`);
      botRunning = false;
      saveSessions();
      try {
        await bot.sendMessage(OWNER_CHAT_ID,
          `❌ *Bot error & berhenti!*\n\`${e.message}\``,
          { parse_mode: 'Markdown', reply_markup: ownerMenu(false) }
        );
      } catch (_) {}
    });
  } else {
    // Kirim IP ke owner
    try {
      await bot.sendMessage(OWNER_CHAT_ID,
        `🖥 *Server Railway aktif!*\n\n` +
        `📡 IP Publik: \`${publicIp}\`\n` +
        `👛 ${privateKeys.length} wallet tersimpan\n` +
        `📁 Data: \`${DATA_DIR}\`\n\n` +
        `_Tekan Start untuk mulai bot._`,
        { parse_mode: 'Markdown', reply_markup: ownerMenu(false) }
      );
    } catch (_) {}

    if (privateKeys.length > 0) {
      log('info', '', `${privateKeys.length} wallet tersimpan. Kirim /start ke bot untuk mulai.`);
    } else {
      log('info', '', 'Belum ada private key. Kirim /start ke bot Telegram untuk input.');
    }
  }
})();