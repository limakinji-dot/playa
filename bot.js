'use strict';

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
 *
 *   USE_PROXY          true / false — baca dari proxy.txt di direktori yang sama
 *
 * CATATAN:
 *   - Private key tidak lagi dari env. Semua diinput via Telegram bot.
 *   - Proxy dibaca dari file proxy.txt (satu proxy per baris, format ip:port)
 *   - Alamat tujuan TX diambil random dari Discord channel
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

const STATE_FILE    = path.join(__dirname, 'state.json');
const LOG_FILE      = path.join(__dirname, 'bot.log');
const PROXY_FILE    = path.join(__dirname, 'proxy.txt');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

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
  faucetCd:     8 * 60 * 60 * 1000,
  crateCd:      24 * 60 * 60 * 1000,
  sendAmount:   '0.001',
  txDelay:      3000,
  discordRefresh: 30 * 60 * 1000,
};

const LOOP_MINUTES = parseInt(process.env.LOOP_MINUTES || '10', 10);
const LOOP_MS      = LOOP_MINUTES * 60 * 1000;
const DAILY_TX     = parseInt(process.env.DAILY_TX     || '50', 10);
const BURN_AMOUNT  = process.env.BURN_AMOUNT            || '0.005';
const PARALLEL     = Math.min(parseInt(process.env.PARALLEL || '5', 10), 30);
const USE_PROXY    = (process.env.USE_PROXY || 'false').toLowerCase() === 'true';

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
  } catch (_) {
    log('info', '', 'sessions.json belum ada, mulai fresh');
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
      subscribers:  [...subscribers],
      privateKeys,
      dailySummary,
    }, null, 2));
  } catch (e) {
    log('error', '', `Gagal save sessions: ${e.message}`);
  }
}

// ============================================================================
//  PROXY MANAGER  — baca dari proxy.txt
// ============================================================================

const proxyPool = { list: [] };

function loadProxyFile() {
  if (!USE_PROXY) return;
  if (!fs.existsSync(PROXY_FILE)) {
    log('warn', '', `proxy.txt tidak ditemukan di: ${PROXY_FILE}`);
    return;
  }
  try {
    const lines = fs.readFileSync(PROXY_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    const parsed = lines.map(l => {
      if (l.startsWith('http://') || l.startsWith('https://')) return l;
      if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(l)) return `http://${l}`;
      // format user:pass@host:port
      if (l.includes('@')) return `http://${l}`;
      return null;
    }).filter(Boolean);

    if (parsed.length === 0) {
      log('warn', '', 'proxy.txt ada tapi tidak ada entry yang valid (format: ip:port)');
      return;
    }

    // shuffle
    for (let i = parsed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [parsed[i], parsed[j]] = [parsed[j], parsed[i]];
    }

    proxyPool.list = parsed;
    log('ok', '', `proxy.txt loaded: ${proxyPool.list.length} proxies`);
  } catch (e) {
    log('error', '', `Gagal baca proxy.txt: ${e.message}`);
  }
}

function getProxyUrl(walletIndex) {
  if (!USE_PROXY || proxyPool.list.length === 0) return null;
  return proxyPool.list[walletIndex % proxyPool.list.length];
}

function getNextProxyUrl(currentIndex) {
  if (!USE_PROXY || proxyPool.list.length === 0) return null;
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
      lastFaucet: 0, lastCrate: 0, txCount: 0,
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

function createProvider(proxyUrl) {
  if (!proxyUrl) return new ethers.JsonRpcProvider(CFG.rpc);
  const agent    = new HttpsProxyAgent(proxyUrl);
  const fetchReq = new ethers.FetchRequest(CFG.rpc);
  fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
  return new ethers.JsonRpcProvider(fetchReq);
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

  async get(endpoint) {
    const r = await this.http.get(endpoint, { headers: this._headers() });
    this._saveCookies(r);
    return r.data;
  }

  async post(endpoint, body = {}) {
    const r = await this.http.post(endpoint, body, { headers: this._headers(true) });
    this._saveCookies(r);
    return r.data;
  }

  profile()      { return this.get('/api/inception/profile/'); }
  faucetClaim()  { return this.post('/api/inception/faucet/'); }
  crateOpen()    { return this.post('/api/inception/crate/open/', { crate_name: 'daily' }); }
  confirmBurn(h) { return this.post('/api/inception/exchange/confirm-burn/', { tx_hash: h }); }
  sync(h)        { return this.post('/api/inception/sync/', { tx_hash: h || '0x' }); }
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
  const elapsed = now - st.lastFaucet;
  if (elapsed < CFG.faucetCd) {
    const h = Math.floor((CFG.faucetCd - elapsed) / 3_600_000);
    const m = Math.floor(((CFG.faucetCd - elapsed) % 3_600_000) / 60_000);
    log('info', addr, `Faucet cooldown — ${h}h ${m}m lagi`);
    return;
  }
  try {
    const r = await api.faucetClaim();
    if (r?.success || r?.tx_hash) {
      st.lastFaucet = now;
      dailySummary[addr].faucetClaims++;
      log('ok', addr, `Faucet claimed — amount: ${r.dacc_amount || r.amount || 'n/a'}`);
    } else {
      log('warn', addr, `Faucet: ${r?.error || r?.reason || JSON.stringify(r)}`);
    }
  } catch (e) {
    const d = e.response?.data;
    if (d?.error?.includes('Link') || d?.error?.includes('activate')) {
      log('warn', addr, 'Faucet: link X atau Discord dulu di inception.dachain.io');
    } else {
      log('error', addr, `Faucet failed: ${d?.error || d?.reason || e.message}`);
    }
  }
}

async function openCrate(api, addr, st, now) {
  initSummary(addr);
  if (now - st.lastCrate < CFG.crateCd) {
    const h = Math.round((CFG.crateCd - (now - st.lastCrate)) / 3_600_000);
    log('info', addr, `Crate cooldown — ${h}h lagi`);
    return;
  }
  try {
    const r = await api.crateOpen();
    if (r?.success) {
      st.lastCrate = now;
      st.crateOpens++;
      dailySummary[addr].crateOpens++;
      log('ok', addr, `Crate #${st.crateOpens} opened — reward: ${r.reward?.label || 'n/a'} | QE: ${r.new_total_qe}`);
    } else {
      log('warn', addr, `Crate: ${r?.error || JSON.stringify(r)}`);
    }
  } catch (e) {
    const d = e.response?.data;
    if (d?.error?.includes('limit') || d?.error?.includes('cooldown')) {
      st.lastCrate = now;
      log('info', addr, 'Crate daily limit reached');
    } else {
      log('error', addr, `Crate failed: ${d?.error || e.message}`);
    }
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
  const balance = await signer.provider.getBalance(addr);
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
  const balance = await signer.provider.getBalance(addr);
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
  if (USE_PROXY) {
    log('info', addr, `Proxy: ${proxyUrl || 'tidak ada proxy tersedia'}`);
  }

  const provider = createProvider(proxyUrl);
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
      if (USE_PROXY && attempt < 2) {
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
  await openCrate(api, addr, st, now);    await sleep(1000);
  await sendTxs(signer, api, addr, st, now); await sleep(1000);
  await burnForQE(signer, api, addr);    await sleep(1000);

  try { await api.sync(); } catch (_) {}

  try {
    const p = await api.profile();
    log('ok', addr,
      `Profile — QE: ${p.qe_balance} | Rank: #${p.user_rank} | Badges: ${p.badges?.length || 0}` +
      ` | Streak: ${p.streak_days}d | TX: ${p.tx_count} | x${p.qe_multiplier}`
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
          [{ text: '⛔ Stop Bot',           callback_data: 'stop'     }],
          [{ text: '➕ Tambah Private Key', callback_data: 'add_keys' }],
          [{ text: '📊 Lihat Summary',      callback_data: 'summary'  }],
        ]
      : [
          [{ text: '🚀 Start Bot',           callback_data: 'start_bot' }],
          [{ text: '➕ Tambah Private Key',  callback_data: 'add_keys'  }],
          [{ text: '📊 Lihat Summary',       callback_data: 'summary'   }],
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
      `Proxy: *${USE_PROXY ? proxyPool.list.length + ' proxies' : 'nonaktif'}*`,
      `Subscribers: *${subscribers.size}*\n`,
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
        `🔀 Proxy: ${USE_PROXY ? proxyPool.list.length + ' proxies' : 'nonaktif'}`,
        { parse_mode: 'Markdown', reply_markup: ownerMenu(true) }
      );

      // Jalankan bot loop di background
      runBotLoop(bot).catch(async (e) => {
        log('error', '', `Bot loop crash: ${e.message}`);
        botRunning = false;
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
  });

  bot.on('polling_error', (err) => {
    log('error', '', `Telegram polling error: ${err.message}`);
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
    // Reload proxy setiap cycle (kalau file berubah)
    if (USE_PROXY) loadProxyFile();

    await runAll(privateKeys);
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

  // Load state tersimpan
  loadSessions();

  // Load proxy
  if (USE_PROXY) loadProxyFile();

  // Inisialisasi Telegram bot
  const bot = initTelegramBot();

  // Jadwalkan daily summary
  scheduleDailySummary(bot);

  console.log(`\nTelegram Bot   : aktif`);
  console.log(`Owner Chat ID  : ${OWNER_CHAT_ID}`);
  console.log(`Wallet saved   : ${privateKeys.length}`);
  console.log(`Subscribers    : ${subscribers.size}`);
  console.log(`Proxy          : ${USE_PROXY ? `aktif (${proxyPool.list.length} dari proxy.txt)` : 'nonaktif'}`);
  console.log(`Discord CH     : ${DISCORD_CHANNEL_ID}\n`);

  if (privateKeys.length > 0) {
    log('info', '', `${privateKeys.length} wallet tersimpan. Kirim /start ke bot untuk mulai.`);
  } else {
    log('info', '', 'Belum ada private key. Kirim /start ke bot Telegram untuk input.');
  }
})();
