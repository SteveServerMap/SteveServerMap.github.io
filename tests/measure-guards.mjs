/**
 * measure-guards.mjs —— 测距交互的两条回归检查
 *
 * 1) 未开启测距时，左键点地图不会产生测量点（修复前会误加）
 * 2) 点「退出」后面板收起、测量点保留；再点「测距」面板恢复且点还在
 *
 * 运行：node tests/measure-guards.mjs
 */
import { startStaticServer, launchBrowser, CDP, Page, createDiagnostics, waitUntil } from './headless.mjs';

const projectRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let server = null;
let browser = null;
let conn = null;
let page = null;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
};

const clickMapCenter = async () => {
  await page.evalFn(() => {
    const el = document.getElementById('viewport') || document.body;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y) || el;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return { x, y };
  });
};

const measureState = () => page.evalFn(() => {
  const app = window.__mapApp;
  const panel = document.getElementById('measure-readout');
  const points = app?.measure?.points?.length ?? app?.measureSummary?.().points?.length ?? -1;
  return { points, panelHidden: panel ? panel.hidden : null, active: Boolean(app?.state?.measureActive) };
});

try {
  server = await startStaticServer({ root: projectRoot, quiet: true });
  browser = await launchBrowser({ headless: true });
  conn = await CDP.connect(browser.wsUrl);
  page = await Page.open(conn);
  createDiagnostics(page, { ignore: (msg) => /tiles\/.*404/.test(msg) });
  await page.setViewport({ width: 1280, height: 800 });
  await page.navigate(server.url, { timeout: 20000 });
  await waitUntil(async () => (await page.evalFn(() => Boolean(window.__mapApp))), { timeout: 15000, label: '应用启动' });

  // 确保测距处于关闭状态
  await page.evalFn(() => {
    const app = window.__mapApp;
    app?.setMeasureActive?.(false);
    app?.clearMeasure?.();
    window.__measureLastClick = null; // 用来判断这次点击有没有被当成「测距点击」处理
  });
  const before = await measureState();

  // 1) 未开测距点地图：不加点，而且这次点击根本不应该进入测距点击路径
  await clickMapCenter();
  await new Promise((r) => setTimeout(r, 250));
  const after = await measureState();
  const clickHandledByMeasure = await page.evalFn(() => Boolean(window.__measureLastClick));
  record(
    '左键点击不误加点',
    after.points === 0 && before.active === false && clickHandledByMeasure === false,
    `点击前 ${before.points} 点 → 点击后 ${after.points} 点（active=${after.active}、进入测距点击=${clickHandledByMeasure}）`,
  );

  // 2) 开测距 → 加点 → 退出
  await page.evalFn(() => window.__mapApp?.setMeasureActive?.(true));
  await clickMapCenter();
  await new Promise((r) => setTimeout(r, 250));
  await clickMapCenter();
  await new Promise((r) => setTimeout(r, 250));
  const during = await measureState();
  await page.evalFn(() => window.__mapApp?.setMeasureActive?.(false));
  await new Promise((r) => setTimeout(r, 200));
  const exited = await measureState();
  record('退出收起面板且点保留', exited.panelHidden === true && exited.points === during.points && exited.points > 0,
    `测量中 ${during.points} 点、面板 ${during.panelHidden ? '隐藏' : '显示'} → 退出后 ${exited.points} 点、面板 ${exited.panelHidden ? '隐藏' : '显示'}`);

  // 3) 再次开启 → 面板恢复、点还在
  await page.evalFn(() => window.__mapApp?.setMeasureActive?.(true));
  await new Promise((r) => setTimeout(r, 200));
  const back = await measureState();
  record('再开测距面板恢复且点还在', back.panelHidden === false && back.points === during.points,
    `面板 ${back.panelHidden ? '隐藏' : '显示'}、${back.points} 点`);
} catch (err) {
  record('运行异常', false, err && err.message ? err.message : String(err));
} finally {
  try { await conn?.close?.(); } catch { /* ignore */ }
  try { await browser?.close?.(); } catch { /* ignore */ }
  try { await server?.close?.(); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${failed.length ? '✗' : '✓'} measure-guards：${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
