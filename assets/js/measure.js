/**
 * measure.js —— 地图测距图层
 *
 * 抄的是常见地图软件的尺子：
 *   · 点一下 = 起点，再点 = 第二点，两点之间就是距离；
 *   · 继续点 = 多段折线，每段单独标距离，末尾给总长；
 *   · 支持吸附到路径点（由 app.js 传入 snapped 世界坐标）；
 *   · 结束（Enter / 面板「结束」）= 当前折线定格保留，再点地图开始新的一条（可同时存在多条）；
 *   · 退出（Esc / 面板「退出」）= 退出测距并清空全部折线（由 app.js 调 clear()）；
 *   · 顶点可以拖吗？不做 —— 微软/高德也都是"点错就撤销上一点"，这里保持一致：
 *     Backspace 撤销上一点（当前折线撤销完会退回到上一条已结束的折线继续撤销）。
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

function segmentsOf(points) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    out.push(distanceBetween(points[i - 1], points[i]));
  }
  return out;
}

function totalOf(points) {
  return segmentsOf(points).reduce((sum, value) => sum + value, 0);
}

export class MeasureLayer {
  /**
   * @param {HTMLElement} overlayEl 地图 overlay（#overlay），SVG 会插在里面
   * @param {{maxPoints?: number}} [options]
   */
  constructor(overlayEl, { maxPoints = 64 } = {}) {
    this.maxPoints = maxPoints;
    /** @type {Array<{x:number, z:number, snapped?: string|null}>} 当前（未结束）折线 */
    this.points = [];
    /** @type {Array<{points: Array<{x:number, z:number, snapped?: string|null}>}>} 已结束的折线 */
    this.lines = [];
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

    // 已结束的折线先画，当前折线盖在最上面
    this.doneGroup = document.createElementNS(SVG_NS, 'g');
    this.doneGroup.setAttribute('class', 'measure-lines-done');
    this.svg.appendChild(this.doneGroup);

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

  /**
   * 结束当前折线：定格保留在图上，下一次 addPoint 开始新的一条。
   * 少于两点（还没成线）时不动，返回 null。
   * @returns {{points: Array, segments: number[], total: number}|null}
   */
  finish() {
    if (this.points.length < 2) return null;
    const points = this.points;
    this.points = [];
    this.hover = null;
    this.lines.push({ points });
    this.redraw();
    return {
      points: points.map((p) => ({ x: p.x, z: p.z })),
      segments: segmentsOf(points),
      total: totalOf(points),
    };
  }

  /** 撤销上一点；当前折线空了就回到上一条已结束的折线，继续撤销它的末点。 */
  undo() {
    let removed = this.points.pop();
    if (!removed && this.lines.length) {
      const line = this.lines.pop();
      this.points = line.points;
      removed = this.points.pop();
    }
    this.redraw();
    return removed || null;
  }

  clear() {
    this.points = [];
    this.lines = [];
    this.hover = null;
    this.redraw();
  }

  setHover(world) {
    if (!this.active) return;
    this.hover = world && Number.isFinite(world.x) ? { x: world.x, z: world.z } : null;
    this.redraw();
  }

  /** 当前折线的每段距离 */
  get segments() {
    return segmentsOf(this.points);
  }

  /** 当前折线总长 */
  get total() {
    return totalOf(this.points);
  }

  /** 已结束折线 + 当前折线的总长 */
  get allTotal() {
    return this.lines.reduce((sum, line) => sum + totalOf(line.points), 0) + totalOf(this.points);
  }

  get summary() {
    const pack = (points) => {
      const segments = segmentsOf(points);
      return {
        points: points.map((p) => ({ x: p.x, z: p.z })),
        segments,
        total: segments.reduce((sum, v) => sum + v, 0),
      };
    };
    const current = pack(this.points);
    const lines = this.lines.map((line) => pack(line.points));
    const allTotal = lines.reduce((sum, line) => sum + line.total, 0) + current.total;
    // points / segments / total 保持「当前折线」的旧语义（宿主与旧断言都在用），
    // 多条测量的信息放在 lines / allTotal 里。
    return { ...current, active: this.active, lines, allTotal };
  }

  /** 每次视图变化时更新（app.js 的 handleViewChange 会调） */
  update(viewState) {
    this.viewState = viewState || this.viewState;
    this.redraw();
  }

  _project(points) {
    const out = [];
    for (const point of points) {
      const screen = this.worldToViewport(point.x, point.z);
      if (screen) out.push(screen);
    }
    return out;
  }

  _fmtPoints(pts) {
    return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }

  _appendVertices(parent, pts, { startLabel = false } = {}) {
    pts.forEach((p, index) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', index === 0 ? 'measure-vertex is-start' : 'measure-vertex');
      circle.setAttribute('cx', String(p.x));
      circle.setAttribute('cy', String(p.y));
      circle.setAttribute('r', index === 0 ? '5.5' : '4.5');
      parent.appendChild(circle);
      if (startLabel && index === 0) {
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'measure-vertex-label');
        label.setAttribute('x', String(p.x + 8));
        label.setAttribute('y', String(p.y - 8));
        label.textContent = '起点';
        parent.appendChild(label);
      }
    });
  }

  _appendSegmentLabels(parent, points, pts) {
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const dist = distanceBetween(points[i - 1], points[i]);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'measure-seg-label');
      label.setAttribute('x', String((a.x + b.x) / 2));
      label.setAttribute('y', String((a.y + b.y) / 2 - 8));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = `${formatDistance(dist)} 格`;
      parent.appendChild(label);
    }
  }

  _appendTotalLabel(parent, pts, total) {
    const last = pts[pts.length - 1];
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'measure-total-label');
    label.setAttribute('x', String(last.x + 12));
    label.setAttribute('y', String(last.y + 18));
    label.textContent = `总长 ${formatDistance(total)} 格`;
    parent.appendChild(label);
  }

  redraw() {
    if (!this.svg) return;
    const vs = this.viewState;
    const proj = this.projection;
    const ready = !!(vs && proj);

    // 已结束的折线：静态绘制，没有预览段，也不标「起点」
    this.doneGroup.textContent = '';
    for (const line of this.lines) {
      if (line.points.length < 2) continue;
      const donePts = ready ? this._project(line.points) : [];
      if (donePts.length < 2) continue;
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', 'measure-done-line');
      const poly = document.createElementNS(SVG_NS, 'polyline');
      poly.setAttribute('class', 'measure-line-done');
      poly.setAttribute('fill', 'none');
      poly.setAttribute('points', this._fmtPoints(donePts));
      group.appendChild(poly);
      this._appendVertices(group, donePts);
      this._appendSegmentLabels(group, line.points, donePts);
      this._appendTotalLabel(group, donePts, totalOf(line.points));
      this.doneGroup.appendChild(group);
    }

    // 当前折线
    const pts = ready ? this._project(this.points) : [];
    this.pathEl.setAttribute('points', this._fmtPoints(pts));
    this.pathEl.style.display = pts.length >= 2 ? '' : 'none';

    // 预览段（最后一个点 → 鼠标）
    const previewPts = [];
    if (this.active && pts.length) {
      const last = pts[pts.length - 1];
      const hover = this.hover ? this.worldToViewport(this.hover.x, this.hover.z) : null;
      if (hover) previewPts.push(last, hover);
      else previewPts.push(last, last);
    }
    this.previewEl.setAttribute('points', this._fmtPoints(previewPts));
    this.previewEl.style.display = previewPts.length === 2 && this.points.length ? '' : 'none';

    // 顶点 / 段标注 / 总长（只有当前折线标「起点」）
    this.vertexGroup.textContent = '';
    this._appendVertices(this.vertexGroup, pts, { startLabel: true });

    this.labelGroup.textContent = '';
    this._appendSegmentLabels(this.labelGroup, this.points, pts);
    if (pts.length >= 2) this._appendTotalLabel(this.labelGroup, pts, totalOf(this.points));

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
