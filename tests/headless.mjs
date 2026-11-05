/**
 * tests/headless.mjs
 * SteveServerMap QA —— 零依赖无头浏览器 / CDP 驱动库。
 *
 * 只使用 Node 24 内置能力：全局 WebSocket、fetch、node:http、node:child_process、node:fs。
 * 不引入任何 npm 依赖，也不依赖 playwright / puppeteer。
 *
 * 提供：
 *   - startStaticServer()   最小静态文件服务器（正确 MIME、支持中文文件名、随机端口）
 *   - launchBrowser()       启动 Edge/Chrome 无头实例并等 DevTools 端口就绪
 *   - CDP                   浏览器级 DevTools 协议连接（自增 id ↔ Promise 映射，支持 sessionId）
 *   - Page                  页面级封装（导航 / evaluate / 等待 / 鼠标滚轮拖拽 / 截图 / 视口）
 *   - createDiagnostics()   收集 console error、未捕获异常、HTTP 4xx/5xx
 *   - createReporter()      统一的 ✓/✗ 报告器（smoke 与 static-checks 共用）
 *   - waitUntil / sleep / parseArgs / formatDuration / truncate
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class CDPError extends Error {
  constructor(method, error) {
    super(`CDP ${method} 失败：${error?.message ?? '未知错误'}${error?.code ? ` (code ${error.code})` : ''}`);
    this.name = 'CDPError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

export function truncate(value, max = 400) {
  const text = String(value ?? '');
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…[共 ${text.length} 字符]` : text;
}

/** 解析 `--key=value` / `--flag` 形式的命令行参数 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) {
      out[match[1]] = match[2] === undefined ? true : match[2];
    } else {
      out._.push(arg);
    }
  }
  return out;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} m ${Math.round((ms % 60_000) / 1000)} s`;
}

export function nowStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 轮询直到 fn 返回真值 */
export async function waitUntil(fn, { timeout = 5000, interval = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new TimeoutError(
    `等待超时（${timeout} ms）：${label}${lastError ? `；最后一次错误：${lastError.message}` : ''}`,
  );
}

/* ------------------------------------------------------------------ *
 * 报告器
 * ------------------------------------------------------------------ */

export function createReporter(name, { log = console.log } = {}) {
  const startedAt = Date.now();
  const results = [];
  const warnings = [];
  let notes = 0;

  const report = {
    name,
    results,
    warnings,
    get passed() {
      return results.filter((r) => r.status === 'pass');
    },
    get failed() {
      return results.filter((r) => r.status === 'fail');
    },
    get skipped() {
      return results.filter((r) => r.status === 'skip');
    },
    get durationMs() {
      return Date.now() - startedAt;
    },
    note(message) {
      notes += 1;
      log(`  · ${message}`);
    },
    warn(label, detail) {
      warnings.push({ label, detail: detail === undefined ? undefined : truncate(detail, 500) });
      log(`  ! ${label}${detail ? ` — ${truncate(detail, 300)}` : ''}`);
    },
    skip(label, reason, id = label) {
      results.push({ id, label, status: 'skip', reason });
      log(`  ⊘ ${label}（跳过：${reason}）`);
    },
    async check(id, label, fn) {
      const t0 = Date.now();
      try {
        const rawDetail = await fn();
        const ms = Date.now() - t0;
        let detail;
        if (rawDetail !== undefined && rawDetail !== null) {
          detail = typeof rawDetail === 'string' ? rawDetail : truncate(JSON.stringify(rawDetail), 400);
        }
        const result = { id, label, status: 'pass', ms, detail };
        results.push(result);
        log(`  ✓ ${label}${detail ? ` — ${detail}` : ''} (${formatDuration(ms)})`);
        return result;
      } catch (error) {
        const ms = Date.now() - t0;
        const result = {
          id,
          label,
          status: 'fail',
          ms,
          error: error?.message ?? String(error),
          stack: error?.stack,
        };
        results.push(result);
        log(`  ✗ ${label} — ${result.error} (${formatDuration(ms)})`);
        return result;
      }
    },
    summary() {
      const pass = report.passed.length;
      const fail = report.failed.length;
      const skip = report.skipped.length;
      const ok = fail === 0;
      log('');
      log(
        `${ok ? '✓' : '✗'} ${name}：${pass} 通过 / ${fail} 失败 / ${skip} 跳过` +
          `${warnings.length ? ` / ${warnings.length} 警告` : ''}` +
          `，耗时 ${formatDuration(report.durationMs)}`,
      );
      return { name, ok, pass, fail, skip, warnings: warnings.length, durationMs: report.durationMs };
    },
    toJSON() {
      return {
        name,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: report.durationMs,
        pass: report.passed.length,
        fail: report.failed.length,
        skip: report.skipped.length,
        warnings,
        results: results.map((r) => ({
          id: r.id,
          label: r.label,
          status: r.status,
          ms: r.ms,
          detail: r.detail,
          reason: r.reason,
          error: r.error,
        })),
      };
    },
  };

  return report;
}

/* ------------------------------------------------------------------ *
 * 最小静态文件服务器
 * ------------------------------------------------------------------ */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 启动静态服务器（监听 127.0.0.1 的随机空闲端口）。
 * @returns {Promise<{root:string, host:string, port:number, origin:string, url:string, close:()=>Promise<void>}>}
 */
export async function startStaticServer({ root = process.cwd(), host = '127.0.0.1', quiet = false } = {}) {
  const rootDir = path.resolve(root);

  async function handle(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', `http://${host}`).pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request（URL 无法解码）');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    const candidate = path.resolve(rootDir, `.${pathname}`);
    const insideRoot = candidate === rootDir || candidate.startsWith(rootDir + path.sep);
    let stat = insideRoot ? await fsp.stat(candidate).catch(() => null) : null;
    let filePath = candidate;
    if (stat?.isDirectory()) {
      filePath = path.join(candidate, 'index.html');
      stat = await fsp.stat(filePath).catch(() => null);
    }

    if (!stat?.isFile()) {
      if (/^\/favicon\.ico$/i.test(pathname)) {
        // 浏览器偶尔仍会请求根 favicon：静默 204，避免污染 console error 断言
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (!quiet) console.log(`  [srv] 404 ${req.method} ${decodeURIComponent(req.url || '')}`);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, max-age=0',
      'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.destroy();
    });
    stream.pipe(res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`500 ${error?.message ?? 'server error'}`);
    });
  });
  server.on('clientError', (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address();
  const origin = `http://${host}:${port}`;

  return {
    root: rootDir,
    host,
    port,
    origin,
    url: `${origin}/index.html`,
    async close() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await Promise.race([
        new Promise((resolve) => server.close(() => resolve())),
        sleep(2000),
      ]);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 浏览器进程
 * ------------------------------------------------------------------ */

const DEFAULT_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function resolveBrowserPath(explicit) {
  const candidates = [explicit, process.env.EDGE_PATH, process.env.CHROME_PATH, ...DEFAULT_BROWSERS]
    .filter((value) => typeof value === 'string' && value.trim().length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `找不到 Edge / Chrome 可执行文件。可用 --browser=<路径> 或环境变量 EDGE_PATH 指定。已尝试：\n  ${candidates.join('\n  ')}`,
  );
}

async function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

/**
 * 兜底清理：按本次唯一的 --user-data-dir 匹配命令行，杀掉所有残留子进程。
 * Edge 有时会「启动器退出但浏览器进程另起」，只靠启动 PID + taskkill /T 会漏。
 */
function killLeftoverByProfile(profileDir) {
  if (process.platform === 'win32') {
    const escaped = profileDir.replace(/'/g, "''");
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" ` +
      `| Where-Object { $_.CommandLine -like '*${escaped}*' } ` +
      `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20_000,
    });
    return;
  }
  spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore' });
}

async function removeProfileDir(profileDir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rm(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

/**
 * 启动无头浏览器。返回句柄与 close()；close() 会杀掉整个进程树并清理临时 profile。
 */
export async function launchBrowser({
  executablePath,
  headless = true,
  port,
  userDataDir,
  windowSize = '1440,900',
  extraArgs = [],
  keepProfile = false,
  timeout = 30_000,
  verbose = false,
} = {}) {
  const exe = resolveBrowserPath(executablePath);
  const debugPort = port ?? (await getFreePort('127.0.0.1'));
  const profileDir = userDataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'ssm-qa-')));

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-popup-blocking',
    '--mute-audio',
    '--remote-allow-origins=*',
    `--window-size=${windowSize}`,
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...extraArgs,
    'about:blank',
  ];

  // stdio: 'ignore' —— 避免部分 Windows 沙箱下管道命名管道 EPERM，同时不阻塞子进程
  const proc = spawn(exe, args, {
    stdio: verbose ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  let exitInfo = null;
  proc.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  proc.on('error', (error) => {
    exitInfo = { code: null, signal: null, error };
  });

  const deadline = Date.now() + timeout;
  let version = null;
  let lastError = null;
  while (Date.now() < deadline) {
    if (exitInfo) {
      throw new Error(
        `浏览器进程提前退出：code=${exitInfo.code ?? '?'} signal=${exitInfo.signal ?? '?'}` +
          `${exitInfo.error ? `（${exitInfo.error.message}）` : ''}\n可执行文件：${exe}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.webSocketDebuggerUrl) {
          version = body;
          break;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  if (!version) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new Error(
      `无法连接浏览器调试端口 127.0.0.1:${debugPort}（等待 ${timeout} ms）` +
        `${lastError ? `，最后错误：${lastError.message}` : ''}`,
    );
  }

  const handle = {
    executablePath: exe,
    pid: proc.pid,
    port: debugPort,
    wsUrl: version.webSocketDebuggerUrl,
    browser: version.Browser,
    userAgent: version['User-Agent'],
    userDataDir: profileDir,
    proc,
    conn: null,
    /** 让 close() 可以先发 Browser.close 优雅退出 */
    attach(cdpConnection) {
      handle.conn = cdpConnection;
    },
    async close({ conn: externalConn } = {}) {
      const activeConn = externalConn ?? handle.conn;
      // ① 优雅关闭：Browser.close 会连同所有 target / 子进程一起退出
      if (activeConn && !activeConn._closed) {
        try {
          await Promise.race([
            activeConn.send('Browser.close').catch(() => {}),
            sleep(2000),
          ]);
        } catch {
          /* ignore */
        }
      }
      // ② 杀启动进程树
      if (proc.exitCode === null && proc.pid) {
        killProcessTree(proc.pid);
        await Promise.race([once(proc, 'exit').catch(() => {}), sleep(5000)]);
      }
      // ③ 仍有残留（启动器退出但浏览器另起）时按 profile 路径兜底
      if (!keepProfile) {
        let removed = await removeProfileDir(profileDir);
        if (!removed) {
          killLeftoverByProfile(profileDir);
          removed = await removeProfileDir(profileDir);
        }
        if (!removed) {
          console.warn(`  ! 临时浏览器 profile 未能删除（可能仍有进程占用）：${profileDir}`);
        }
      } else if (processAlive(proc.pid)) {
        killProcessTree(proc.pid);
      }
    },
  };

  return handle;
}

/* ------------------------------------------------------------------ *
 * CDP 连接
 * ------------------------------------------------------------------ */

export class CDP {
  constructor(wsUrl, { commandTimeout = 30_000 } = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeout = commandTimeout;
    this._nextId = 0;
    this._pending = new Map();
    this._handlers = new Map();
    this._closed = false;
    this.ws = null;
  }

  static async connect(wsUrl, { commandTimeout = 30_000, connectTimeout = 15_000 } = {}) {
    const client = new CDP(wsUrl, { commandTimeout });
    await client.open({ timeout: connectTimeout });
    return client;
  }

  async open({ timeout = 15_000 } = {}) {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener('message', (event) => this._onMessage(event.data));
    ws.addEventListener('close', () => {
      this._closed = true;
      for (const pending of this._pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP 连接已关闭'));
      }
      this._pending.clear();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TimeoutError(`连接 CDP WebSocket 超时（${timeout} ms）：${this.wsUrl}`)),
        timeout,
      );
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket 连接失败：${this.wsUrl}`));
        },
        { once: true },
      );
    });
  }

  _onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CDPError(pending.method, message.error));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      this._emit(message.method, message.params ?? {}, message.sessionId);
    }
  }

  _emit(method, params, sessionId) {
    const handlers = this._handlers.get(method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(params, sessionId);
      } catch (error) {
        console.error(`[headless] CDP 事件处理器抛错（${method}）：${error?.stack ?? error}`);
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error(`CDP 连接已关闭，无法发送 ${method}`));
    const id = ++this._nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new TimeoutError(`CDP 命令超时（${this.commandTimeout} ms）：${method}`));
      }, this.commandTimeout);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    let set = this._handlers.get(method);
    if (!set) {
      set = new Set();
      this._handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this._handlers.delete(method);
    };
  }

  waitForEvent(method, { timeout = 30_000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new TimeoutError(`等待 CDP 事件超时（${timeout} ms）：${method}`));
      }, timeout);
      const off = this.on(method, (params, sessionId) => {
        let matched = false;
        try {
          matched = Boolean(predicate(params, sessionId));
        } catch {
          matched = false;
        }
        if (!matched) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this._closed = true;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP 连接已关闭'));
    }
    this._pending.clear();
    this._handlers.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 页面封装
 * ------------------------------------------------------------------ */

function describeRemoteObject(arg) {
  if (!arg) return '?';
  if (arg.type === 'string') return arg.value;
  if ('value' in arg && arg.value !== undefined) {
    return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
  }
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.description) return arg.description;
  return arg.type;
}

export class Page {
  constructor(conn, { targetId, sessionId }) {
    this.conn = conn;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  static async open(conn, { url = 'about:blank' } = {}) {
    const { targetId } = await conn.send('Target.createTarget', { url });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(conn, { targetId, sessionId });
    await Promise.all([
      page.send('Page.enable'),
      page.send('Runtime.enable'),
      page.send('Log.enable').catch(() => {}),
      page.send('Network.enable').catch(() => {}),
      page.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {}),
    ]);
    return page;
  }

  send(method, params = {}) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** 仅订阅本页面 session 的事件 */
  on(method, handler) {
    return this.conn.on(method, (params, sessionId) => {
      if (!sessionId || sessionId === this.sessionId) handler(params);
    });
  }

  waitForEvent(method, { timeout = 30_000, predicate } = {}) {
    return this.conn.waitForEvent(method, {
      timeout,
      predicate: (params, sessionId) =>
        (!sessionId || sessionId === this.sessionId) && (!predicate || predicate(params)),
    });
  }

  async addInitScript(source) {
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
    return identifier;
  }

  async navigate(url, { timeout = 30_000 } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', { timeout }).catch(() => null);
    const result = await this.send('Page.navigate', { url });
    if (result?.errorText && result.errorText !== 'net::ERR_ABORTED') {
      throw new Error(`页面导航失败：${result.errorText}（${url}）`);
    }
    await loaded;
    await this.waitFor(() => document.readyState === 'complete', {
      timeout: Math.min(timeout, 15_000),
      interval: 100,
      label: 'document.readyState === "complete"',
    }).catch(() => {});
    return result;
  }

  async evaluate(
    expression,
    { awaitPromise = true, returnByValue = true, userGesture = true } = {},
  ) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture,
      includeCommandLineAPI: false,
    });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      const description = details.exception?.description || details.text || '未知错误';
      throw new Error(
        `页面内表达式抛错：${truncate(description, 800)}\n表达式：${truncate(expression, 500)}`,
      );
    }
    return response.result?.value;
  }

  /** 把函数序列化后带参数在页面里执行：page.evalFn((a,b)=>..., 1, 2) */
  evalFn(fn, ...args) {
    const argSource = args.map((arg) => JSON.stringify(arg)).join(', ');
    return this.evaluate(`(${fn.toString()})(${argSource})`);
  }

  /** 轮询页面内条件，返回该条件的返回值 */
  async waitFor(fn, { timeout = 10_000, interval = 100, label = '页面条件', args = [] } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evalFn(fn, ...args);
        if (last) return last;
      } catch {
        last = undefined;
      }
      await sleep(interval);
    }
    throw new TimeoutError(`等待超时（${timeout} ms）：${label}`);
  }

  /** 等两帧 + 短暂延迟，保证 transform / 标记重排已经落到布局上 */
  async settle(extraDelay = 60) {
    await this.evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, ${Number(
        extraDelay,
      )}))))`,
    );
  }

  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    await this.settle(120);
  }

  async clearViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride');
    await this.settle(120);
  }

  async click(x, y, { button = 'left', clickCount = 1, delay = 30 } = {}) {
    const base = { x, y, button, clickCount };
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...base,
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(delay);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...base,
      buttons: 0,
      pointerType: 'mouse',
    });
    await sleep(delay);
  }

  async clickSelector(selector, { index = 0 } = {}) {
    const target = await this.evalFn(
      (sel, idx) => {
        const elements = Array.from(document.querySelectorAll(sel));
        const element = elements[idx];
        if (!element) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || '').trim().slice(0, 80),
          count: elements.length,
        };
      },
      selector,
      index,
    );
    if (!target) throw new Error(`找不到可点击元素：${selector}[${index}]`);
    if (target.width <= 0 || target.height <= 0) {
      throw new Error(`元素尺寸为 0，无法点击：${selector}[${index}]（${JSON.stringify(target)}）`);
    }
    await this.click(target.x, target.y);
    return target;
  }

  async wheel({ x, y, deltaY = 0, deltaX = 0, modifiers = 0 }) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      modifiers,
      pointerType: 'mouse',
    });
    await sleep(60);
  }

  async drag({ from, to, steps = 10, settleMs = 80 }) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = from.x + (to.x - from.x) * ratio;
      const y = from.y + (to.y - from.y) * ratio;
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(16);
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await sleep(settleMs);
  }

  async screenshotBase64() {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return data;
  }

  async screenshot(filePath) {
    const data = await this.screenshotBase64();
    await ensureDir(path.dirname(filePath));
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  async url() {
    return this.evaluate('location.href');
  }

  async close() {
    await this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 页面诊断（console error / 未捕获异常 / HTTP 错误）
 * ------------------------------------------------------------------ */

/**
 * @param {Page} page
 * @param {{ignore?: (error: {kind:string, text:string, where?:string}) => boolean}} [options]
 *   ignore 返回 true 的错误不计入（例如瓦片底图的 404 属于正常情况，见 docs/CONTRACT.md）
 */
export function createDiagnostics(page, { ignore } = {}) {
  const errors = [];
  const offs = [];
  const shouldIgnore = typeof ignore === 'function' ? ignore : () => false;
  const push = (error) => {
    try {
      if (shouldIgnore(error)) return;
    } catch {
      /* ignore 回调自身出错时按「不忽略」处理 */
    }
    errors.push(error);
  };

  offs.push(
    page.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'assert') return;
      const text = (params.args || []).map(describeRemoteObject).join(' ');
      const frame = params.stackTrace?.callFrames?.[0];
      push({
        kind: params.type === 'assert' ? 'console.assert' : 'console.error',
        text,
        where: frame ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : undefined,
      });
    }),
  );

  offs.push(
    page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const exception = exceptionDetails?.exception;
      push({
        kind: 'exception',
        text: exception?.description || exceptionDetails?.text || '未捕获异常',
        where:
          exceptionDetails?.url != null
            ? `${exceptionDetails.url}:${(exceptionDetails.lineNumber ?? 0) + 1}`
            : undefined,
      });
    }),
  );

  offs.push(
    page.on('Log.entryAdded', ({ entry }) => {
      if (!entry || entry.level !== 'error') return;
      push({
        kind: `log.${entry.source || 'unknown'}`,
        text: entry.text,
        where: entry.url,
      });
    }),
  );

  offs.push(
    page.on('Network.responseReceived', ({ response }) => {
      if (!response?.status || response.status < 400) return;
      // 404 等资源错误单独归类：集成期最常见的问题
      push({
        kind: 'network.http',
        text: `HTTP ${response.status} ${response.statusText || ''}`.trim(),
        where: response.url,
      });
    }),
  );

  return {
    errors,
    get count() {
      return errors.length;
    },
    clear() {
      errors.length = 0;
    },
    snapshot() {
      return errors.map((error) => ({ ...error }));
    },
    format(limit = 12) {
      return errors
        .slice(0, limit)
        .map((error, index) => `${index + 1}. [${error.kind}] ${truncate(error.text, 300)}${error.where ? `（${truncate(error.where, 200)}）` : ''}`);
    },
    dispose() {
      offs.forEach((off) => off());
      offs.length = 0;
    },
  };
}
