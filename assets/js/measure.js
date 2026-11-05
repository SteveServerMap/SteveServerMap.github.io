/**
 * measure.js —— 地图测距图层
 *
 * 抄的是常见地图软件的尺子：
 *   · 点一下 = 起点，再点 = 第二点，两点之间就是距离；
 *   · 继续点 = 多段折线，每段单独标距离，末尾给总长；
 *   · 支持吸附到路径点（由 app.js 传入 snapped 世界坐标）；
 *   · 顶点可以拖吗？不做 —— 微软/高德也都是"点错就撤销上一点"，这里保持一致：
 *     Backspace 撤销上一点，Esc 退出，Enter 结束（结束后仍可继续点）。
 *
 * 坐标系：测量点用**世界坐标**保存，所以缩放/平移/换维度画幅变化都不会错位。
 * 渲染用 SVG：line 描边清晰，文字标注也比 canvas 省事。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 世界坐标两点距离（方块 / 格） */
export function distanceBetween(a, b) {
  if (!a || !b) return 0;
  const dx = Number(b.x) - Number(a.x);
  const dz = Number(b.z) - Number(a.z);
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return 0;
  return Math.hypot(dx, dz);
}

/** 格式化距离：小于 10 保留一位小数，否则取整 */
export function formatDistance(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(1);
  return String(Math.round(v));
}

export class MeasureLayer {
  /**
   * @param {HTMLElement} overlayEl 地图 overlay（#overlay），SVG 会插在里面
   * @param {{maxPoints?: number}} [options]
   */
  constructor(overlayEl, { maxPoints = 64 } = {}) {
    this.maxPoints = maxPoints;
    /** @type {Array<{x:number, z:number, snapped?: string|null}>} */
    this.points = [];
    this.hover = null;
    this.active = false;
    this.projection = null;
    this.viewState = null;
    this._lastSummary = { segments: [], total: 0 };

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'measure-layer');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:3';
    overlayEl?.append(this.svg);

    this.pathEl = document.createElementNS(SVG_NS, 'polyline');
    this.pathEl.setAttribute('class', 'measure-line');
    this.pathEl.setAttribute('fill', 'none');
    this.svg.appendChild(this.pathEl);

    this.previewEl = document.createElementNS(SVG_NS, 'polyline');
    this.previewEl.setAttribute('class', 'measure-preview');
    this.previewEl.setAttribute('fill', 'none');
    this.svg.appendChild(this.previewEl);

    this.vertexGroup = document.createElementNS(SVG_NS, 'g');
    this.vertexGroup.setAttribute('class', 'measure-vertices');
    this.svg.appendChild(this.vertexGroup);

    this.labelGroup = document.createElementNS(SVG_NS, 'g');
    this.labelGroup.setAttribute('class', 'measure-labels');
    this.svg.appendChild(this.labelGroup);
  }

  setProjection(projection) {
    this.projection = projection || null;
    this.redraw();
  }

  setActive(active) {
    this.active = !!active;
    this.svg.classList.toggle('is-active', this.active);
    if (!this.active) this.hover = null;
    this.redraw();
  }

  /** 世界坐标 → 视口坐标（相对 #viewport，与 overlay 原点一致） */
  worldToViewport(x, z) {
    const proj = this.projection;
    if (!proj || typeof proj.worldToImage !== 'function') return null;
    const img = proj.worldToImage(x, z);
    if (!img || !Number.isFinite(img.px)) return null;
    const vs = this.viewState;
    if (!vs) return null;
    return { x: img.px * vs.scale + vs.tx, y: img.py * vs.scale + vs.ty };
  }

  /**
   * 加一个点；返回 {index, segment} —— segment 是「与上一点的距离」（首点为 0）。
   * 未开启测距（this.active === false）时拒绝加点：app.js 的 handleMeasureClick 已有一道守卫，
   * 这里是第二道保险，保证任何调用方都无法在非测量模式下往图上塞点。
   */
  addPoint(world) {
    if (!this.active) return null;
    if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.z)) return null;
    if (this.points.length >= this.maxPoints) {
      this.points.shift();
    }
    const point = { x: Number(world.x), z: Number(world.z), snapped: world.snapped ?? null };
    const prev = this.points[this.points.length - 1] || null;
    this.points.push(point);
    this.redraw();
    return { index: this.points.length - 1, segment: prev ? distanceBetween(prev, point) : 0 };
  }

  undo() {
    const removed = this.points.pop();
    this.redraw();
    return removed || null;
  }

  clear() {
    this.points = [];
    this.hover = null;
    this.redraw();
  }

  setHover(world) {
    if (!this.active) return;
    this.hover = world && Number.isFinite(world.x) ? { x: world.x, z: world.z } : null;
    this.redraw();
  }

  get segments() {
    const out = [];
    for (let i = 1; i < this.points.length; i += 1) {
      out.push(distanceBetween(this.points[i - 1], this.points[i]));
    }
    return out;
  }

  get total() {
    return this.segments.reduce((sum, value) => sum + value, 0);
  }

  get summary() {
    const segments = this.segments;
    return {
      points: this.points.map((p) => ({ x: p.x, z: p.z })),
      segments,
      total: segments.reduce((sum, v) => sum + v, 0),
      active: this.active,
    };
  }

  /** 每次视图变化时更新（app.js 的 handleViewChange 会调） */
  update(viewState) {
    this.viewState = viewState || this.viewState;
    this.redraw();
  }

  redraw() {
    if (!this.svg) return;
    const vs = this.viewState;
    const proj = this.projection;
    const pts = [];
    if (vs && proj) {
      for (const point of this.points) {
        const screen = this.worldToViewport(point.x, point.z);
        if (screen) pts.push(screen);
      }
    }

    // 主折线
    this.pathEl.setAttribute('points', pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    this.pathEl.style.display = pts.length >= 2 ? '' : 'none';

    // 预览段（最后一个点 → 鼠标）
    const previewPts = [];
    if (this.active && pts.length) {
      const last = pts[pts.length - 1];
      const hover = this.hover ? this.worldToViewport(this.hover.x, this.hover.z) : null;
      if (hover) previewPts.push(last, hover);
      else previewPts.push(last, last);
    }
    this.previewEl.setAttribute('points', previewPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    this.previewEl.style.display = previewPts.length === 2 && this.points.length ? '' : 'none';

    // 顶点
    this.vertexGroup.textContent = '';
    pts.forEach((p, index) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', 'measure-vertex');
      circle.setAttribute('cx', String(p.x));
      circle.setAttribute('cy', String(p.y));
      circle.setAttribute('r', index === 0 ? '5.5' : '4.5');
      this.vertexGroup.appendChild(circle);
      if (index === 0) {
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'measure-vertex-label');
        label.setAttribute('x', String(p.x + 8));
        label.setAttribute('y', String(p.y - 8));
        label.textContent = '起点';
        this.vertexGroup.appendChild(label);
      }
    });

    // 每段距离标注
    this.labelGroup.textContent = '';
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const dist = distanceBetween(this.points[i - 1], this.points[i]);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'measure-seg-label');
      label.setAttribute('x', String((a.x + b.x) / 2));
      label.setAttribute('y', String((a.y + b.y) / 2 - 8));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = `${formatDistance(dist)} 格`;
      this.labelGroup.appendChild(label);
    }

    // 总长标注（跟在最后一个点后面）
    if (pts.length >= 2) {
      const last = pts[pts.length - 1];
      const total = document.createElementNS(SVG_NS, 'text');
      total.setAttribute('class', 'measure-total-label');
      total.setAttribute('x', String(last.x + 12));
      total.setAttribute('y', String(last.y + 18));
      total.textContent = `总长 ${formatDistance(this.total)} 格`;
      this.labelGroup.appendChild(total);
    }

    // 预览段长度（跟随鼠标）
    if (this.active && previewPts.length === 2 && this.points.length) {
      const a = previewPts[0];
      const b = previewPts[1];
      const last = this.points[this.points.length - 1];
      const hoverDist = this.hover ? distanceBetween(last, this.hover) : 0;
      if (hoverDist > 0) {
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'measure-seg-label is-preview');
        label.setAttribute('x', String((a.x + b.x) / 2));
        label.setAttribute('y', String((a.y + b.y) / 2 - 8));
        label.setAttribute('text-anchor', 'middle');
        label.textContent = `${formatDistance(hoverDist)} 格`;
        this.labelGroup.appendChild(label);
      }
    }

    this._lastSummary = this.summary;
  }

  destroy() {
    this.svg?.remove();
  }
}

export default MeasureLayer;
