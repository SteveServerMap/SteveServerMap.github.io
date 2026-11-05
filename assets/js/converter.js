/**
 * assets/js/converter.js —— 主世界 ↔ 下界 坐标换算
 * =============================================================================
 * Minecraft 下界旅行规则：下界 1 方块 = 主世界 8 方块（X / Z 同比例，Y 不变，
 * 站点地图是 XZ 平面，所以本模块只算 X / Z）。
 *
 * 铁律沿用 coords.js：
 *   - 纯函数部分零 DOM，可在 Node 下 `import` 单测（tests/converter.test.mjs）；
 *   - 永不抛异常：非法入参返回 null，由调用方决定提示文案。
 */

/** 主世界 / 下界 的坐标比例：下界 1 格 = 主世界 8 格 */
export const NETHER_SCALE = 8;

/** 宽松数值化：number / 数字字符串 → number；其余 → NaN */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 主世界坐标 → 下界坐标（÷8，四舍五入到整数方块）。
 * @param {number|string} x
 * @param {number|string} z
 * @returns {null | {x: number, z: number}}
 */
export function overworldToNether(x, z) {
  const X = toNum(x);
  const Z = toNum(z);
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null;
  return { x: Math.round(X / NETHER_SCALE), z: Math.round(Z / NETHER_SCALE) };
}

/**
 * 下界坐标 → 主世界坐标（×8）。
 * @param {number|string} x
 * @param {number|string} z
 * @returns {null | {x: number, z: number}}
 */
export function netherToOverworld(x, z) {
  const X = toNum(x);
  const Z = toNum(z);
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null;
  return { x: X * NETHER_SCALE, z: Z * NETHER_SCALE };
}

/**
 * 坐标换算面板：只操作 index.html 里既有的 #convert-panel 节点，
 * 节点缺失时只 console.warn（与 sidebar.js 的容错策略一致）。
 */
export class ConverterPanel {
  /**
   * @param {HTMLElement} rootEl #convert-panel
   * @param {{
   *   getCenter?: () => (null | {x: number, z: number}),
   *   onLocate?: (x: number, z: number) => void,
   * }} [options]
   */
  constructor(rootEl, options = {}) {
    this.root = rootEl || document.getElementById('convert-panel');
    this.options = options || {};
    this._open = false;
    this._direction = 'ow2n'; // 'ow2n' 主世界→下界 | 'n2ow' 下界→主世界
    this._listeners = [];

    this.el = {};
    for (const [key, id] of Object.entries({
      x: 'convert-x',
      z: 'convert-z',
      result: 'convert-result',
      copy: 'convert-copy',
      locate: 'convert-locate',
      close: 'convert-close',
      dirOw: 'convert-dir-ow',
      dirN: 'convert-dir-n',
    })) {
      const node = this.root ? this.root.querySelector(`#${id}`) : null;
      if (!node) console.warn(`[converter] 找不到节点 #${id}，对应功能已跳过`);
      this.el[key] = node;
    }

    this._bind();
  }

  /* ------------------------------------------------------------------ *
   * 公开 API
   * ------------------------------------------------------------------ */

  isOpen() {
    return this._open;
  }

  /**
   * 打开 / 收起面板。
   * @param {boolean} open
   * @param {{prefill?: {x: number, z: number}}} [opts] 打开时若输入为空则预填
   */
  setOpen(open, opts = {}) {
    this._open = open === true;
    if (this.root) this.root.hidden = !this._open;
    if (this._open) {
      const prefill = opts.prefill;
      const xEl = this.el.x;
      const zEl = this.el.z;
      if (
        prefill && Number.isFinite(prefill.x) && Number.isFinite(prefill.z) &&
        xEl && zEl && !xEl.value && !zEl.value
      ) {
        xEl.value = String(prefill.x);
        zEl.value = String(prefill.z);
      }
      this._recompute();
    }
  }

  /** 当前面板的换算结果（输入非法时为 null） */
  convert() {
    const x = this._readInput(this.el.x);
    const z = this._readInput(this.el.z);
    if (x === null || z === null) return null;
    return this._direction === 'ow2n'
      ? overworldToNether(x, z)
      : netherToOverworld(x, z);
  }

  destroy() {
    for (const { node, type, handler, options } of this._listeners) {
      node.removeEventListener(type, handler, options);
    }
    this._listeners = [];
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  _on(node, type, handler, options) {
    if (!node || typeof node.addEventListener !== 'function') return;
    node.addEventListener(type, handler, options);
    this._listeners.push({ node, type, handler, options });
  }

  _bind() {
    this._on(this.el.dirOw, 'click', () => this._setDirection('ow2n'));
    this._on(this.el.dirN, 'click', () => this._setDirection('n2ow'));
    this._on(this.el.x, 'input', () => this._recompute());
    this._on(this.el.z, 'input', () => this._recompute());
    this._on(this.el.close, 'click', () => this.setOpen(false));
    this._on(this.el.copy, 'click', () => this._copyResult());
    this._on(this.el.locate, 'click', () => this._locate());
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this._on(document, 'keydown', (event) => {
        if (!this._open) return;
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        event.preventDefault();
        this.setOpen(false);
      });
    }
    this._setDirection('ow2n');
  }

  _setDirection(direction) {
    this._direction = direction;
    if (this.el.dirOw) {
      this.el.dirOw.classList.toggle('is-active', direction === 'ow2n');
      this.el.dirOw.setAttribute('aria-pressed', direction === 'ow2n' ? 'true' : 'false');
    }
    if (this.el.dirN) {
      this.el.dirN.classList.toggle('is-active', direction === 'n2ow');
      this.el.dirN.setAttribute('aria-pressed', direction === 'n2ow' ? 'true' : 'false');
    }
    this._recompute();
  }

  _readInput(el) {
    if (!el) return null;
    const raw = String(el.value ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  _recompute() {
    const result = this.el.result;
    if (!result) return;
    const out = this.convert();
    if (!out) {
      result.textContent = '—';
      result.classList.add('is-empty');
      return;
    }
    result.classList.remove('is-empty');
    result.textContent = `X ${out.x}   Z ${out.z}`;
  }

  _resultText() {
    const out = this.convert();
    return out ? `X ${out.x} Z ${out.z}` : '';
  }

  _copyResult() {
    const text = this._resultText();
    if (!text) return;
    const done = () => {
      if (typeof this.options.onCopy === 'function') this.options.onCopy(text);
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => this._legacyCopy(text, done));
    } else {
      this._legacyCopy(text, done);
    }
  }

  _legacyCopy(text, onDone) {
    if (typeof document === 'undefined') return;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      Object.assign(ta.style, { position: 'fixed', top: '-1000px', opacity: '0' });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (onDone) onDone();
    } catch (err) {
      console.warn('[converter] 复制失败', err);
    }
  }

  _locate() {
    const out = this.convert();
    if (!out) return;
    if (typeof this.options.onLocate === 'function') this.options.onLocate(out.x, out.z);
  }
}

export default ConverterPanel;
