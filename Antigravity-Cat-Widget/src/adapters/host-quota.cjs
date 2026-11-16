const { EventEmitter } = require('node:events');
const { discover, Cdp } = require('../../../shared/host.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

let currentAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
let currentToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
let lastDiscoverTime = 0;

function execPowerShell(command, timeout = 3500) {
  return new Promise((resolve) => {
    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve('');
        resolve(String(stdout).trim());
      }
    );
  });
}

async function discoverLs() {
  const now = Date.now();
  if (now - lastDiscoverTime < 10000) return null;
  lastDiscoverTime = now;

  try {
    const psCmd = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'*language_server*\' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
    const raw = await execPowerShell(psCmd, 3500);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const proc = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!proc || !proc.CommandLine) return null;
    const tokenMatch = proc.CommandLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
    if (!tokenMatch) return null;
    const token = tokenMatch[1];
    const pid = proc.ProcessId;

    const netCmd = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`;
    const netRaw = await execPowerShell(netCmd, 3500);
    if (!netRaw) return null;
    const ports = netRaw.split(/\s+/).map(Number).filter(p => p > 0);

    for (const port of ports) {
      const addr = `127.0.0.1:${port}`;
      try {
        const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': token },
          body: '{}',
          signal: AbortSignal.timeout(1000)
        });
        if (res.ok) {
          return { addr, token };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Read only quota fields from the native IDE cache or Desktop Models view cache.
function readHostQuota() {
  const result = { fiveHour: null, weekly: null, fetchedAt: null };
  let group = typeof pY !== 'undefined' && Array.isArray(pY) ? pY.find(g => g && g.displayName === 'Gemini Models') : null;
  if (!group && typeof document !== 'undefined') {
    const seen = new Set();
    for (const el of document.querySelectorAll('[role=dialog] *')) {
      let fiber = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))];
      for (let i = 0; fiber && i < 40; fiber = fiber.return, i++) {
        if (seen.has(fiber)) break;
        seen.add(fiber);
        for (let state = fiber.memoizedState, j = 0; state && j < 80; state = state.next, j++) {
          if (Array.isArray(state.memoizedState)) {
            group = state.memoizedState.find(g => g && g.displayName === 'Gemini Models') || group;
          }
        }
      }
      if (group) break;
    }
  }
  if (!group) return result;
  result.cacheAvailable = true;
  for (const b of group.buckets || []) {
    const key = b.bucketId === 'gemini-5h' ? 'fiveHour' : b.bucketId === 'gemini-weekly' ? 'weekly' : null;
    const value = b.remaining?.case === 'remainingFraction' ? b.remaining.value : null;
    if (key && !b.disabled && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      result[key] = value * 100;
    }
  }
  if (typeof jFb === 'number' && Number.isFinite(jFb) && jFb > 0 && jFb <= Date.now() + 60000) {
    result.fetchedAt = jFb;
  }
  return result;
}

async function fetchLsQuota() {
  const authFile = path.join(os.homedir(), '.antigravity-cat-widget', 'ls-auth.json');
  if (!currentAddr || !currentToken) {
    try {
      if (fs.existsSync(authFile)) {
        const cached = JSON.parse(fs.readFileSync(authFile, 'utf8'));
        currentAddr = currentAddr || cached.addr;
        currentToken = currentToken || cached.token;
      }
    } catch {}
  }

  async function tryFetch(addr, token) {
    if (!addr || !token) return null;
    const url = 'http://' + addr + '/exa.language_server_pb.LanguageServerService/GetUserStatus';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': token
      },
      body: '{}',
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return null;
    return await res.json();
  }

  let data = null;
  try {
    data = await tryFetch(currentAddr, currentToken);
  } catch {}

  // 如果连接失败，尝试自动探测当前存活的 Antigravity 实例
  if (!data) {
    const discovered = await discoverLs();
    if (discovered) {
      currentAddr = discovered.addr;
      currentToken = discovered.token;
      try {
        fs.mkdirSync(path.dirname(authFile), { recursive: true });
        fs.writeFileSync(authFile, JSON.stringify({ addr: currentAddr, token: currentToken }), 'utf8');
      } catch {}
      try {
        data = await tryFetch(currentAddr, currentToken);
      } catch {}
    }
  }

  if (!data) return null;

  const configs = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  let fiveHour = null, weekly = null;
  for (const m of configs) {
    const frac = m.quotaInfo?.remainingFraction;
    if (typeof frac === 'number') {
      const val = Math.round(frac * 1000) / 10;
      const reset = m.quotaInfo?.resetTime ? new Date(m.quotaInfo.resetTime).getTime() : 0;
      const diffHours = (reset - Date.now()) / (3600 * 1000);

      if (fiveHour === null && (m.label?.includes('Flash') || (diffHours > 0 && diffHours <= 6))) {
        fiveHour = val;
      } else if (weekly === null && (m.label?.includes('Argon') || m.label?.includes('Pro') || diffHours > 24)) {
        weekly = val;
      }
    }
  }
  if (fiveHour !== null || weekly !== null) {
    return { fiveHour, weekly, fetchedAt: Date.now() };
  }
  return null;
}

class HostQuotaAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.discover = options.discover || discover;
    this.Client = options.Client || Cdp;
    this.now = options.now || Date.now;
    this.snapshot = { fiveHour: null, weekly: null, fetchedAt: null, online: false };
    this.active = false;
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 30000);
  }
  async tick() {
    if (this.busy || !this.active) return;
    this.busy = true;
    let c;
    try {
      const lsSample = await fetchLsQuota();
      if (lsSample) {
        this.sampleAt = this.now();
        this.snapshot = {
          fiveHour: lsSample.fiveHour,
          weekly: lsSample.weekly,
          cached: false,
          stale: false,
          observedAt: this.sampleAt,
          fetchedAt: lsSample.fetchedAt,
          online: true
        };
        return;
      }
      const host = await this.discover();
      if (!host) throw new Error('offline');
      if (this.hostIdentity && this.hostIdentity !== host.target.webSocketDebuggerUrl) {
        this.snapshot = { fiveHour: null, weekly: null, fetchedAt: null, online: false };
        this.sampleAt = null;
      }
      this.hostIdentity = host.target.webSocketDebuggerUrl;
      c = new this.Client(host.target.webSocketDebuggerUrl);
      const sample = await c.evaluate('(' + readHostQuota.toString() + ')()');
      if (!sample?.cacheAvailable) {
        if (this.sampleAt !== null && this.sampleAt !== undefined) {
          this.snapshot = { ...this.snapshot, online: true, cached: true, stale: this.now() - this.sampleAt >= 300000 };
        } else {
          this.snapshot = { fiveHour: null, weekly: null, fetchedAt: null, online: true };
        }
        return;
      }
      if (typeof sample.fiveHour === 'number' || typeof sample.weekly === 'number') {
        this.sampleAt = this.now();
      }
      if (this.active) {
        this.snapshot = {
          fiveHour: typeof sample?.fiveHour === 'number' && sample.fiveHour >= 0 && sample.fiveHour <= 100 ? sample.fiveHour : null,
          weekly: typeof sample?.weekly === 'number' && sample.weekly >= 0 && sample.weekly <= 100 ? sample.weekly : null,
          cached: false,
          stale: false,
          observedAt: this.sampleAt,
          fetchedAt: typeof sample?.fetchedAt === 'number' ? sample.fetchedAt : null,
          online: true
        };
      }
    } catch {
      if (this.active) this.snapshot = { ...this.snapshot, online: false, cached: true, stale: true };
    } finally {
      c?.close();
      this.busy = false;
      if (this.active) this.emit('change', this.snapshot);
    }
  }
  async openNativeQuota() {
    let c;
    try {
      const host = await this.discover();
      if (!host) return;
      c = new this.Client(host.target.webSocketDebuggerUrl);
      await c.evaluate("(()=>{if(document.querySelector('[role=dialog]'))return;[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Settings')?.click()})()");
      await new Promise(resolve => setTimeout(resolve, 350));
      await c.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.innerText.trim()==='Models')?.click()");
      await new Promise(resolve => setTimeout(resolve, 1200));
      await this.tick();
    } finally {
      c?.close();
    }
  }
  stop() {
    this.active = false;
    clearInterval(this.timer);
  }
}

module.exports = { HostQuotaAdapter, readHostQuota };
