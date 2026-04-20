'use strict';

/**
 * DAC Inception - Daily Multi-Wallet Bot
 * https://inception.dachain.io/activity
 *
 * Chain : DAC Quantum Chain (ID: 21894)
 * RPC   : https://rpctest.dachain.tech
 *
 * Environment variables (set di Railway):
 *
 *   PK_1 ... PK_30     private key per wallet (0x + 64 hex), maks 30
 *   PARALLEL           jumlah wallet yang jalan bersamaan (default: 5)
 *   DAILY_TX           target TX per hari per wallet (default: 50)
 *   LOOP_MINUTES       interval loop dalam menit (default: 10)
 *   BURN_AMOUNT        DAC dibakar per siklus (default: 0.005)
 *   PORT               port ping server (default: 3000)
 *
 *   USE_PROXY          true / false (default: false)
 *                      - free proxy: otomatis fetch dari ProxyScrape (tidak perlu konfigurasi apapun)
 *                      - premium proxy: set PROXY_USER dan PROXY_PASS
 *   PROXY_USER         username ProxyScrape premium (opsional)
 *   PROXY_PASS         password ProxyScrape premium (opsional)
 */

const { ethers }          = require('ethers');
const axios               = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const http                = require('http');
const fs                  = require('fs');
const path                = require('path');

// ---------------------------------------------------------------------------
//  PING SERVER  (supaya Railway free tier tidak sleep)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bot is running');
}).listen(PORT, () => {
  console.log(`[INFO] Ping server listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
//  CONFIG
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_FILE   = path.join(__dirname, 'bot.log');

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
  proxyListUrl: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  proxyRefresh: 30 * 60 * 1000,
};

const LOOP_MINUTES = parseInt(process.env.LOOP_MINUTES || '10', 10);
const LOOP_MS      = LOOP_MINUTES * 60 * 1000;
const DAILY_TX     = parseInt(process.env.DAILY_TX     || '50', 10);
const BURN_AMOUNT  = process.env.BURN_AMOUNT            || '0.005';
const PARALLEL     = Math.min(parseInt(process.env.PARALLEL || '5', 10), 30);
const USE_PROXY    = (process.env.USE_PROXY || 'false').toLowerCase() === 'true';
const PROXY_USER   = process.env.PROXY_USER || '';
const PROXY_PASS   = process.env.PROXY_PASS || '';
const ONCE         = process.argv.includes('--once');
const USE_CRON     = process.argv.includes('--cron');

const CYCLES_PER_DAY = Math.floor((24 * 60) / LOOP_MINUTES);
const TX_PER_CYCLE   = Math.max(1, Math.ceil(DAILY_TX / CYCLES_PER_DAY));

// ---------------------------------------------------------------------------
//  LOGGER
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
//  OUTBOUND IP DETECTION  (untuk whitelist di ProxyScrape premium)
// ---------------------------------------------------------------------------

async function detectOutboundIp() {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
    const ip = r.data?.ip || 'unknown';
    log('info', '', `Outbound IP Railway: ${ip}`);
    log('info', '', `Jika pakai ProxyScrape premium, whitelist IP ini di: https://proxyscrape.com/dashboard`);
    return ip;
  } catch (_) {
    log('warn', '', 'Tidak bisa detect outbound IP');
    return null;
  }
}

// ---------------------------------------------------------------------------
//  PROXY MANAGER
// ---------------------------------------------------------------------------

const proxyPool = {
  list:        [],
  lastFetched: 0,
};

async function fetchProxyList() {
  try {
    log('info', '', 'Fetching proxy list dari ProxyScrape...');
    const r = await axios.get(CFG.proxyListUrl, { timeout: 15000 });
    const lines = r.data
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(l));

    if (lines.length === 0) {
      log('warn', '', 'Proxy list kosong dari ProxyScrape');
      return;
    }

    // Shuffle supaya distribusi lebih merata
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }

    proxyPool.list        = lines;
    proxyPool.lastFetched = Date.now();
    log('ok', '', `Proxy list updated: ${lines.length} proxies tersedia`);
  } catch (e) {
    log('error', '', `Gagal fetch proxy list: ${e.message}`);
  }
}

async function ensureProxies() {
  if (!USE_PROXY) return;
  const expired = Date.now() - proxyPool.lastFetched > CFG.proxyRefresh;
  if (proxyPool.list.length === 0 || expired) {
    await fetchProxyList();
  }
}

// Ambil proxy untuk wallet index tertentu
function getProxyUrl(walletIndex) {
  if (!USE_PROXY) return null;

  // Kalau ada kredensial premium, pakai format username:password@host:port
  if (PROXY_USER && PROXY_PASS) {
    // ProxyScrape premium: gunakan endpoint dedicated mereka
    return `http://${PROXY_USER}:${PROXY_PASS}@proxy.proxyscrape.com:8080`;
  }

  if (proxyPool.list.length === 0) return null;
  const idx = walletIndex % proxyPool.list.length;
  return `http://${proxyPool.list[idx]}`;
}

function getNextProxyUrl(currentIndex) {
  if (!USE_PROXY || proxyPool.list.length === 0) return null;
  const idx = (currentIndex + 1) % proxyPool.list.length;
  return `http://${proxyPool.list[idx]}`;
}

// ---------------------------------------------------------------------------
//  STATE
// ---------------------------------------------------------------------------

// Lock sederhana supaya write state tidak bentrok antar parallel wallet
const stateLock = { locked: false, queue: [] };

function acquireLock() {
  return new Promise(resolve => {
    if (!stateLock.locked) {
      stateLock.locked = true;
      resolve();
    } else {
      stateLock.queue.push(resolve);
    }
  });
}

function releaseLock() {
  if (stateLock.queue.length > 0) {
    const next = stateLock.queue.shift();
    next();
  } else {
    stateLock.locked = false;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getWalletState(all, addr) {
  if (!all[addr]) {
    all[addr] = {
      lastFaucet:  0,
      lastCrate:   0,
      txCount:     0,
      txToday:     0,
      txDayStart:  0,
      crateOpens:  0,
      cycles:      0,
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

// Save state dengan lock supaya aman saat parallel
async function saveWalletState(addr, st) {
  await acquireLock();
  try {
    const all  = loadState();
    all[addr]  = st;
    saveState(all);
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
//  HTTP CLIENT FACTORY
// ---------------------------------------------------------------------------

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
  if (!proxyUrl) {
    return new ethers.JsonRpcProvider(CFG.rpc);
  }
  const agent    = new HttpsProxyAgent(proxyUrl);
  const fetchReq = new ethers.FetchRequest(CFG.rpc);
  fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
  return new ethers.JsonRpcProvider(fetchReq);
}

// ---------------------------------------------------------------------------
//  API CLIENT
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
//  ACTIVITIES
// ---------------------------------------------------------------------------

async function claimFaucet(api, addr, st, now) {
  const elapsed = now - st.lastFaucet;
  if (elapsed < CFG.faucetCd) {
    const h = Math.floor((CFG.faucetCd - elapsed) / 3600000);
    const m = Math.floor(((CFG.faucetCd - elapsed) % 3600000) / 60000);
    log('info', addr, `Faucet cooldown - ${h}h ${m}m lagi`);
    return;
  }
  try {
    const r = await api.faucetClaim();
    if (r?.success || r?.tx_hash) {
      st.lastFaucet = now;
      log('ok', addr, `Faucet claimed - amount: ${r.dacc_amount || r.amount || 'n/a'}`);
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
  if (now - st.lastCrate < CFG.crateCd) {
    const h = Math.round((CFG.crateCd - (now - st.lastCrate)) / 3600000);
    log('info', addr, `Crate cooldown - ${h}h lagi`);
    return;
  }
  try {
    const r = await api.crateOpen();
    if (r?.success) {
      st.lastCrate = now;
      st.crateOpens++;
      log('ok', addr, `Crate #${st.crateOpens} opened - reward: ${r.reward?.label || 'n/a'} | QE: ${r.new_total_qe}`);
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
  resetDailyTxIfNeeded(st, now);

  const remaining = DAILY_TX - st.txToday;
  if (remaining <= 0) {
    log('info', addr, `Daily TX tercapai (${st.txToday}/${DAILY_TX}) - skip`);
    return;
  }

  const toSend  = Math.min(TX_PER_CYCLE, remaining);
  const balance = await signer.provider.getBalance(addr);
  const sendWei = ethers.parseEther(CFG.sendAmount);
  const minWei  = sendWei + ethers.parseEther('0.001');

  if (balance < minWei) {
    log('warn', addr, `Balance rendah (${ethers.formatEther(balance)} DAC) - skip TX`);
    return;
  }

  log('info', addr, `TX siklus ini: ${toSend} | hari ini: ${st.txToday}/${DAILY_TX}`);

  let sent = 0;
  for (let i = 0; i < toSend; i++) {
    try {
      const tx = await signer.sendTransaction({ to: addr, value: sendWei });
      st.txCount++;
      st.txToday++;
      sent++;
      log('ok', addr, `TX #${st.txCount} - ${tx.hash.slice(0, 20)} | ${CFG.sendAmount} DAC | hari ini: ${st.txToday}/${DAILY_TX}`);
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
  const balance = await signer.provider.getBalance(addr);
  const burnWei = ethers.parseEther(BURN_AMOUNT);
  const needed  = burnWei + ethers.parseEther('0.001');

  if (balance < needed) {
    log('info', addr, `Burn skipped - butuh ${BURN_AMOUNT} DAC, punya ${ethers.formatEther(balance)} DAC`);
    return;
  }

  try {
    const contract = new ethers.Contract(CFG.qeContract, CFG.qeAbi, signer);
    const tx       = await contract.burnForQE({ value: burnWei });
    log('info', addr, `Burn submitted: ${tx.hash.slice(0, 20)}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      log('ok', addr, `Burned ${BURN_AMOUNT} DAC -> QE`);
      await api.confirmBurn(tx.hash);
      await api.sync(tx.hash);
    } else {
      log('warn', addr, 'Burn TX reverted');
    }
  } catch (e) {
    log('error', addr, `Burn failed: ${e.reason || e.message}`);
  }
}

// ---------------------------------------------------------------------------
//  WALLET CYCLE
// ---------------------------------------------------------------------------

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

  // Load state
  const allState = loadState();
  const st       = getWalletState(allState, addr);

  // Auth dengan retry + rotate proxy kalau gagal
  log('info', addr, 'Authenticating...');
  let authOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const auth = await api.init();
      const qe   = auth?.user?.qe_balance ?? 'n/a';
      log('ok', addr, `Authenticated - QE: ${qe}`);
      authOk = true;
      break;
    } catch (e) {
      if (USE_PROXY && attempt < 2) {
        const newProxy = getNextProxyUrl(walletIndex + attempt);
        log('warn', addr, `Auth gagal (attempt ${attempt + 1}/3), rotate proxy -> ${newProxy}`);
        api.http = createHttpClient(CFG.api, newProxy);
      } else {
        log('error', addr, `Auth failed: ${e.message}`);
      }
    }
  }

  if (!authOk) return;

  // Balance
  try {
    const bal = await provider.getBalance(addr);
    log('info', addr, `Balance: ${ethers.formatEther(bal)} DAC`);
  } catch (_) {}

  // Activities
  await claimFaucet(api, addr, st, now);
  await sleep(1000);

  await openCrate(api, addr, st, now);
  await sleep(1000);

  await sendTxs(signer, api, addr, st, now);
  await sleep(1000);

  await burnForQE(signer, api, addr);
  await sleep(1000);

  // Sync
  try { await api.sync(); } catch (_) {}

  // Profile
  try {
    const p = await api.profile();
    log('ok', addr,
      `Profile - QE: ${p.qe_balance} | Rank: #${p.user_rank} | Badges: ${p.badges?.length || 0}` +
      ` | Streak: ${p.streak_days}d | TX: ${p.tx_count} | x${p.qe_multiplier}`
    );
  } catch (_) {}

  // Save state (dengan lock aman untuk parallel)
  st.cycles++;
  await saveWalletState(addr, st);
}

// ---------------------------------------------------------------------------
//  PARALLEL RUNNER
// ---------------------------------------------------------------------------

// Jalankan array task dengan concurrency limit
async function runParallel(tasks, limit) {
  const results = [];
  let index     = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        await tasks[i]();
      } catch (e) {
        log('error', '', `Worker error pada task ${i + 1}: ${e.message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function runAll(keys) {
  const divider = '='.repeat(55);
  console.log(`\n${divider}`);
  console.log(`Menjalankan ${keys.length} wallet | paralel: ${PARALLEL}`);
  console.log(`${divider}\n`);

  const startTime = Date.now();

  const tasks = keys.map((pk, i) => async () => {
    const label = `[Wallet ${i + 1}/${keys.length}]`;
    console.log(`\n--- ${label} mulai ---`);
    try {
      await runWallet(pk, i);
    } catch (e) {
      log('error', '', `Fatal error wallet ${i + 1}: ${e.message}`);
    }
    console.log(`--- ${label} selesai ---`);
  });

  await runParallel(tasks, PARALLEL);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${divider}`);
  console.log(`Cycle selesai dalam ${elapsed}s`);
  console.log(`${divider}\n`);
}

// ---------------------------------------------------------------------------
//  HELPERS
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadKeys() {
  const keys = [];
  for (let i = 1; i <= 30; i++) {
    const val = process.env[`PK_${i}`];
    if (!val) continue;
    const pk = val.trim();
    if (pk.startsWith('0x') && pk.length === 66) {
      keys.push(pk);
      log('info', '', `PK_${i} loaded`);
    } else {
      log('warn', '', `PK_${i} format tidak valid, dilewati`);
    }
  }

  if (keys.length === 0) {
    console.log('[ERROR] Tidak ada private key ditemukan.');
    console.log('        Set env variable: PK_1=0x... sampai PK_30=0x...');
    process.exit(1);
  }

  return keys;
}

// ---------------------------------------------------------------------------
//  MAIN
// ---------------------------------------------------------------------------

(async () => {
  console.log('\n======================================================');
  console.log('  DAC Inception - Daily Bot');
  console.log('  https://inception.dachain.io/activity');
  console.log('======================================================\n');

  // Detect IP Railway (berguna untuk whitelist ProxyScrape premium)
  await detectOutboundIp();

  const keys = loadKeys();

  console.log(`\nWallets       : ${keys.length} (maks 30)`);
  console.log(`Parallel      : ${PARALLEL} wallet sekaligus`);
  console.log(`Loop interval : ${LOOP_MINUTES} menit`);
  console.log(`Cycles/day    : ~${CYCLES_PER_DAY}`);
  console.log(`Daily TX      : ${DAILY_TX} per wallet`);
  console.log(`TX per cycle  : ${TX_PER_CYCLE}`);
  console.log(`Send amount   : ${CFG.sendAmount} DAC`);
  console.log(`Burn amount   : ${BURN_AMOUNT} DAC`);
  console.log(`Faucet CD     : 8 jam`);
  console.log(`Proxy         : ${USE_PROXY
    ? (PROXY_USER ? 'aktif (ProxyScrape premium)' : 'aktif (ProxyScrape free)')
    : 'nonaktif'}\n`);

  if (USE_PROXY) {
    await ensureProxies();
  }

  if (ONCE) {
    await runAll(keys);
    return;
  }

  if (USE_CRON) {
    console.log('Cron mode - runs at 00:00 / 06:00 / 12:00 / 18:00 UTC\n');
    const triggers = [
      { hour: 0,  min: 0 },
      { hour: 6,  min: 0 },
      { hour: 12, min: 0 },
      { hour: 18, min: 0 },
    ];
    let lastRun = '';
    setInterval(() => {
      const now = new Date();
      const key = `${now.getUTCHours()}:${now.getUTCMinutes()}`;
      for (const t of triggers) {
        if (now.getUTCHours() === t.hour && now.getUTCMinutes() === t.min && lastRun !== key) {
          lastRun = key;
          log('info', '', `Cron triggered ${String(t.hour).padStart(2, '0')}:00 UTC`);
          ensureProxies()
            .then(() => runAll(keys))
            .catch(e => log('error', '', `Cron error: ${e.message}`));
        }
      }
    }, 60000);
    await runAll(keys);
    return;
  }

  console.log(`Loop mode - setiap ${LOOP_MINUTES} menit\n`);
  while (true) {
    await ensureProxies();
    await runAll(keys);
    log('info', '', `Next cycle in ${LOOP_MINUTES} minutes...`);
    await sleep(LOOP_MS);
  }
})();
