/**
 * tests/coords.test.mjs —— coords.js 的单元测试（node:test + node:assert）
 *
 * 运行：node --test tests/coords.test.mjs
 *
 * 覆盖范围（契约 §2）：
 *   - createProjection 正算 / 反算 / 往返 / flipZ / blocksPerPixel / 非法参数退化
 *   - normalizeCalibration 两种写法（四边画幅、缩放+原点）、缺字段、字符串数字、xMin 优先
 *   - calibrationFromTwoPoints 正常反解、flipZ 推断、退化情形返回 null、反解结果自洽
 *   - boundsFromScale
 *   - formatCoords / fmtBlock / distanceXZ
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjection,
  normalizeCalibration,
  calibrationFromTwoPoints,
  boundsFromScale,
  formatCoords,
  fmtBlock,
  distanceXZ,
} from '../assets/js/coords.js';

/** 浮点近似断言 */
function closeTo(actual, expected, tol = 1e-9, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} 期望 ${expected}，实际 ${actual}（容差 ${tol}）`,
  );
}

/* ========================================================================== */
/* createProjection：正算                                                      */
/* ========================================================================== */

test('createProjection：1 像素 = 1 方块时正算命中四角与中心', () => {
  const p = createProjection({
    xMin: -1792, xMax: 1792, zMin: -2560, zMax: 2560,
    imageWidth: 3584, imageHeight: 5120,
  });

  assert.equal(p.isValid, true);
  assert.equal(p.flipZ, false);
  assert.equal(p.blocksPerPixelX, 1);
  assert.equal(p.blocksPerPixelZ, 1);

  // 左上角 = (xMin, zMin)，右下角 = (xMax, zMax)
  assert.deepEqual(p.worldToImage(-1792, -2560), { px: 0, py: 0 });
  assert.deepEqual(p.worldToImage(1792, 2560), { px: 3584, py: 5120 });
  // 世界原点正好落在图片中心
  assert.deepEqual(p.worldToImage(0, 0), { px: 1792, py: 2560 });
});

test('createProjection：分辨率与画幅不一致时按比例换算（blocksPerPixel ≠ 1）', () => {
  const p = createProjection({
    xMin: 0, xMax: 1000, zMin: 0, zMax: 2000,
    imageWidth: 250, imageHeight: 1000,
  });

  assert.equal(p.isValid, true);
  assert.equal(p.blocksPerPixelX, 4);   // 4 方块 / 像素
  assert.equal(p.blocksPerPixelZ, 2);   // 2 方块 / 像素

  assert.deepEqual(p.worldToImage(250, 500), { px: 62.5, py: 250 });
  assert.deepEqual(p.worldToImage(1000, 2000), { px: 250, py: 1000 });
});

/* ========================================================================== */
/* createProjection：反算 / 往返                                               */
/* ========================================================================== */

test('createProjection：反算是正算的严格逆运算（含画幅外的外推点）', () => {
  const p = createProjection({
    xMin: -1792, xMax: 1792, zMin: -2560, zMax: 2560,
    imageWidth: 3584, imageHeight: 5120,
  });

  const samples = [
    [0, 0],
    [1000, -1500],
    [-1792, -2560],
    [1792, 2560],
    [-3000, 4000], // 画幅外：线性外推也必须可逆
  ];

  for (const [x, z] of samples) {
    const img = p.worldToImage(x, z);
    const back = p.imageToWorld(img.px, img.py);
    closeTo(back.x, x, 1e-9, `x 往返 @(${x},${z})`);
    closeTo(back.z, z, 1e-9, `z 往返 @(${x},${z})`);
  }

  // 反向：像素 -> 世界 -> 像素
  for (const [pxx, pyy] of [[0, 0], [3584, 5120], [123.4, 4567.8]]) {
    const w = p.imageToWorld(pxx, pyy);
    const back = p.worldToImage(w.x, w.z);
    closeTo(back.px, pxx, 1e-9, 'px 往返');
    closeTo(back.py, pyy, 1e-9, 'py 往返');
  }
});

/* ========================================================================== */
/* createProjection：flipZ                                                     */
/* ========================================================================== */

test('createProjection：flipZ 时图片上边缘是世界 Z 最大值', () => {
  const normal = createProjection({
    xMin: 0, xMax: 100, zMin: 0, zMax: 100, imageWidth: 100, imageHeight: 100,
  });
  const flipped = createProjection({
    xMin: 0, xMax: 100, zMin: 0, zMax: 100, imageWidth: 100, imageHeight: 100, flipZ: true,
  });

  // 常规：zMin 在上边缘（py=0）
  assert.deepEqual(normal.worldToImage(0, 0), { px: 0, py: 0 });
  assert.deepEqual(normal.worldToImage(0, 100), { px: 0, py: 100 });

  // 翻转：zMax 在上边缘（py=0），zMin 在下边缘（py=100）
  assert.deepEqual(flipped.worldToImage(0, 100), { px: 0, py: 0 });
  assert.deepEqual(flipped.worldToImage(0, 0), { px: 0, py: 100 });

  // 翻转后往返仍然自洽
  for (const z of [0, 25, 50, 100]) {
    const img = flipped.worldToImage(50, z);
    closeTo(flipped.imageToWorld(img.px, img.py).z, z, 1e-9, `flipZ 往返 z=${z}`);
  }

  // flipZ 不影响 X
  assert.deepEqual(flipped.worldToImage(30, 0).px, normal.worldToImage(30, 0).px);
});

/* ========================================================================== */
/* createProjection：非法参数退化                                              */
/* ========================================================================== */

test('createProjection：非法参数返回 isValid=false 且退化为恒等映射（不抛异常）', () => {
  const bad = [
    undefined,
    {},
    { xMin: 0, xMax: 0, zMin: 0, zMax: 10, imageWidth: 10, imageHeight: 10 }, // xMin == xMax
    { xMin: 10, xMax: -10, zMin: -10, zMax: 10, imageWidth: 10, imageHeight: 10 }, // x 反向
    { xMin: 0, xMax: 10, zMin: 5, zMax: 5, imageWidth: 10, imageHeight: 10 }, // z 反向/相等
    { xMin: 0, xMax: 10, zMin: 0, zMax: 10, imageWidth: 0, imageHeight: 10 }, // 宽 0
    { xMin: 0, xMax: 10, zMin: 0, zMax: 10, imageWidth: 10, imageHeight: -1 }, // 高负数
    { xMin: NaN, xMax: 10, zMin: 0, zMax: 10, imageWidth: 10, imageHeight: 10 },
    { xMin: 'abc', xMax: 10, zMin: 0, zMax: 10, imageWidth: 10, imageHeight: 10 },
  ];

  for (const params of bad) {
    const p = createProjection(params);
    assert.equal(p.isValid, false, `应判定为非法：${JSON.stringify(params)}`);
    // 退化 = 恒等映射：坏配置下标记至少不会飞到 NaN 去
    assert.deepEqual(p.worldToImage(5, 7), { px: 5, py: 7 });
    assert.deepEqual(p.imageToWorld(5, 7), { x: 5, z: 7 });
    assert.ok(Number.isNaN(p.blocksPerPixelX));
    assert.ok(Number.isNaN(p.blocksPerPixelZ));
  }
});

test('createProjection：合法投影遇到 NaN/undefined 坐标只返回 NaN，不抛异常', () => {
  const p = createProjection({
    xMin: 0, xMax: 100, zMin: 0, zMax: 100, imageWidth: 100, imageHeight: 100,
  });
  assert.ok(Number.isNaN(p.worldToImage(NaN, 0).px));
  assert.ok(Number.isNaN(p.worldToImage(0, undefined).py));
  assert.ok(Number.isNaN(p.imageToWorld('x', 0).x));

  // 数字字符串按数值处理（config.json 手写常见）
  assert.deepEqual(p.worldToImage('50', '50'), { px: 50, py: 50 });
});

test('createProjection：极端画幅（跨度极小/极大）仍然精确', () => {
  const tiny = createProjection({
    xMin: 0, xMax: 0.001, zMin: 0, zMax: 0.001, imageWidth: 1000, imageHeight: 1000,
  });
  assert.equal(tiny.isValid, true);
  closeTo(tiny.worldToImage(0.0005, 0.0005).px, 500, 1e-6, '极小画幅 px');
  closeTo(tiny.imageToWorld(500, 500).x, 0.0005, 1e-12, '极小画幅反算');

  const huge = createProjection({
    xMin: -1e9, xMax: 1e9, zMin: -1e9, zMax: 1e9, imageWidth: 1, imageHeight: 1,
  });
  assert.equal(huge.isValid, true);
  assert.equal(huge.blocksPerPixelX, 2e9);
  closeTo(huge.worldToImage(1e9, -1e9).px, 1, 1e-9, '极大画幅 px');
  closeTo(huge.imageToWorld(1, 0).x, 1e9, 1e-3, '极大画幅反算');
});

/* ========================================================================== */
/* boundsFromScale                                                             */
/* ========================================================================== */

test('boundsFromScale：缩放+原点 → 四边画幅', () => {
  const b = boundsFromScale(
    { pixelsPerBlock: 2, originX: -100, originZ: -50 },
    { imageWidth: 200, imageHeight: 100 },
  );
  assert.deepEqual(b, { xMin: -100, xMax: 0, zMin: -50, zMax: 0, pixelsPerBlock: 2 });

  // 分辨率翻倍 → 世界跨度减半
  const b2 = boundsFromScale(
    { pixelsPerBlock: 4, originX: 0, originZ: 0 },
    { imageWidth: 200, imageHeight: 100 },
  );
  assert.deepEqual(b2, { xMin: 0, xMax: 50, zMin: 0, zMax: 25, pixelsPerBlock: 4 });
});

test('boundsFromScale：非法入参返回 null', () => {
  assert.equal(boundsFromScale({ pixelsPerBlock: 0, originX: 0, originZ: 0 }, { imageWidth: 10, imageHeight: 10 }), null);
  assert.equal(boundsFromScale({ pixelsPerBlock: -1, originX: 0, originZ: 0 }, { imageWidth: 10, imageHeight: 10 }), null);
  assert.equal(boundsFromScale({ pixelsPerBlock: 1, originX: NaN, originZ: 0 }, { imageWidth: 10, imageHeight: 10 }), null);
  assert.equal(boundsFromScale({ pixelsPerBlock: 1, originX: 0, originZ: 0 }, { imageWidth: 0, imageHeight: 10 }), null);
  assert.equal(boundsFromScale({}, { imageWidth: 10, imageHeight: 10 }), null);
  assert.equal(boundsFromScale(), null);
});

/* ========================================================================== */
/* normalizeCalibration                                                        */
/* ========================================================================== */

test('normalizeCalibration：四边画幅写法原样通过', () => {
  const cal = normalizeCalibration({
    calibrated: true,
    xMin: -1792, xMax: 1792, zMin: -2560, zMax: 2560,
    flipZ: false,
    note: '默认画幅',
  }, { imageWidth: 3584, imageHeight: 5120 });

  assert.deepEqual(cal, {
    calibrated: true,
    xMin: -1792, xMax: 1792, zMin: -2560, zMax: 2560,
    flipZ: false,
    note: '默认画幅',
    source: 'bounds',
  });
});

test('normalizeCalibration：缩放+原点写法换算为四边画幅', () => {
  const cal = normalizeCalibration(
    { pixelsPerBlock: 2, originX: -500, originZ: -500 },
    { imageWidth: 1000, imageHeight: 1000 },
  );
  assert.equal(cal.source, 'scale');
  assert.equal(cal.xMin, -500);
  assert.equal(cal.xMax, 0);
  assert.equal(cal.zMin, -500);
  assert.equal(cal.zMax, 0);
  assert.equal(cal.pixelsPerBlock, 2);
  assert.equal(cal.calibrated, false); // 未声明 calibrated → 视为未校准
});

test('normalizeCalibration：缩放+原点 + flipZ 时 origin 仍是左上角（上边缘 = zMax）', () => {
  const cal = normalizeCalibration(
    { pixelsPerBlock: 2, originX: 0, originZ: 0, flipZ: true },
    { imageWidth: 1000, imageHeight: 1000 },
  );
  // 跨度 500 方块，originZ = 0 是左上角 → 上边缘 z = 0 = zMax，下边缘 z = -500 = zMin
  assert.deepEqual({ xMin: cal.xMin, xMax: cal.xMax, zMin: cal.zMin, zMax: cal.zMax }, {
    xMin: 0, xMax: 500, zMin: -500, zMax: 0,
  });

  // 用它建投影后，左上角像素应映回 (originX, originZ)
  const p = createProjection({ ...cal, imageWidth: 1000, imageHeight: 1000 });
  assert.equal(p.isValid, true);
  const corner = p.imageToWorld(0, 0);
  assert.deepEqual({ x: corner.x, z: corner.z }, { x: 0, z: 0 });
});

test('normalizeCalibration：xMin 写法优先于缩放+原点写法', () => {
  const cal = normalizeCalibration({
    xMin: -10, xMax: 10, zMin: -10, zMax: 10,
    pixelsPerBlock: 1, originX: 999, originZ: 999,
  }, { imageWidth: 100, imageHeight: 100 });
  assert.equal(cal.source, 'bounds');
  assert.equal(cal.xMax, 10);
});

test('normalizeCalibration：四边画幅非法时回退到缩放+原点写法', () => {
  const cal = normalizeCalibration({
    xMin: 100, xMax: -100, zMin: -10, zMax: 10, // X 反向，非法
    pixelsPerBlock: 1, originX: 0, originZ: 0,
  }, { imageWidth: 50, imageHeight: 50 });
  assert.equal(cal.source, 'scale');
  assert.equal(cal.xMin, 0);
  assert.equal(cal.xMax, 50);
});

test('normalizeCalibration：缺字段 / 空对象 / null 一律返回 null', () => {
  assert.equal(normalizeCalibration(null), null);
  assert.equal(normalizeCalibration(undefined), null);
  assert.equal(normalizeCalibration('nope'), null);
  assert.equal(normalizeCalibration([]), null);
  assert.equal(normalizeCalibration({}), null);
  assert.equal(normalizeCalibration({ calibrated: true }), null);
  assert.equal(normalizeCalibration({ xMin: 0, xMax: 10, zMin: 0 }), null); // 缺 zMax
  assert.equal(normalizeCalibration({ pixelsPerBlock: 1 }, { imageWidth: 10, imageHeight: 10 }), null); // 缺 origin
  // 缩放写法但没给图片尺寸
  assert.equal(normalizeCalibration({ pixelsPerBlock: 1, originX: 0, originZ: 0 }), null);
});

test('normalizeCalibration：字符串数字也能解析（config.json 手写容错）', () => {
  const cal = normalizeCalibration({
    xMin: '-100', xMax: '100', zMin: '-50', zMax: '50', flipZ: 0,
  });
  assert.equal(cal.source, 'bounds');
  assert.equal(cal.xMin, -100);
  assert.equal(cal.zMax, 50);
  assert.equal(cal.flipZ, false);
});

/* ========================================================================== */
/* calibrationFromTwoPoints                                                    */
/* ========================================================================== */

test('calibrationFromTwoPoints：由两个已知地标反解画幅', () => {
  const r = calibrationFromTwoPoints(
    { px: 0, py: 0, x: -1000, z: -2000 },
    { px: 1000, py: 2000, x: 0, z: 0 },
    { imageWidth: 1000, imageHeight: 2000 },
  );
  assert.deepEqual(r, { xMin: -1000, xMax: 0, zMin: -2000, zMax: 0, flipZ: false });
});

test('calibrationFromTwoPoints：反解结果能精确复现原两点（自洽性）', () => {
  // 假设真实画幅：2048×2048 像素覆盖 [-1024,1024]²
  const truth = createProjection({
    xMin: -1024, xMax: 1024, zMin: -1024, zMax: 1024,
    imageWidth: 2048, imageHeight: 2048,
  });

  const aWorld = { x: 100, z: -50 };
  const bWorld = { x: -300, z: 150 };
  const aImg = truth.worldToImage(aWorld.x, aWorld.z);
  const bImg = truth.worldToImage(bWorld.x, bWorld.z);

  const solved = calibrationFromTwoPoints(
    { px: aImg.px, py: aImg.py, ...aWorld },
    { px: bImg.px, py: bImg.py, ...bWorld },
    { imageWidth: 2048, imageHeight: 2048 },
  );

  assert.deepEqual(solved, { xMin: -1024, xMax: 1024, zMin: -1024, zMax: 1024, flipZ: false });

  const re = createProjection({ ...solved, imageWidth: 2048, imageHeight: 2048 });
  const backA = re.worldToImage(aWorld.x, aWorld.z);
  closeTo(backA.px, aImg.px, 1e-9, 'A.px 复现');
  closeTo(backA.py, aImg.py, 1e-9, 'A.py 复现');
});

test('calibrationFromTwoPoints：南北翻转的图能推断出 flipZ', () => {
  // 图片上边缘（py=0）是世界 Z 最大值
  const r = calibrationFromTwoPoints(
    { px: 0, py: 0, x: 0, z: 0 },
    { px: 1000, py: 1000, x: 1000, z: -1000 },
    { imageWidth: 1000, imageHeight: 1000 },
  );
  assert.equal(r.flipZ, true);
  assert.equal(r.xMin, 0);
  assert.equal(r.xMax, 1000);
  assert.equal(r.zMin, -1000);
  assert.equal(r.zMax, 0);

  // 带上 flipZ 建投影，两点都应精确落回原位
  const p = createProjection({ ...r, imageWidth: 1000, imageHeight: 1000 });
  assert.equal(p.isValid, true);
  assert.deepEqual(p.worldToImage(0, 0), { px: 0, py: 0 });
  assert.deepEqual(p.worldToImage(1000, -1000), { px: 1000, py: 1000 });
});

test('calibrationFromTwoPoints：退化情形返回 null', () => {
  const opts = { imageWidth: 1000, imageHeight: 1000 };
  const okA = { px: 0, py: 0, x: 0, z: 0 };

  // 两点的 px 相同 → X 轴无法反解
  assert.equal(calibrationFromTwoPoints(okA, { px: 0, py: 500, x: 100, z: 100 }, opts), null);
  // 两点的 py 相同 → Z 轴无法反解
  assert.equal(calibrationFromTwoPoints(okA, { px: 500, py: 0, x: 100, z: 100 }, opts), null);
  // 世界 X 相同 → X 跨度 0
  assert.equal(calibrationFromTwoPoints(okA, { px: 500, py: 500, x: 0, z: 100 }, opts), null);
  // 世界 Z 相同 → Z 跨度 0
  assert.equal(calibrationFromTwoPoints(okA, { px: 500, py: 500, x: 100, z: 0 }, opts), null);
  // 两点完全重合
  assert.equal(calibrationFromTwoPoints(okA, { ...okA }, opts), null);
  // 点左右填反（世界 X 递减）→ X 反向，无法满足 xMax > xMin
  assert.equal(calibrationFromTwoPoints(okA, { px: 1000, py: 1000, x: -1000, z: 1000 }, opts), null);
  // 坐标非数值
  assert.equal(calibrationFromTwoPoints(okA, { px: 'a', py: 1000, x: 1000, z: 1000 }, opts), null);
  // 图片尺寸缺失
  assert.equal(calibrationFromTwoPoints(okA, { px: 1000, py: 1000, x: 1000, z: 1000 }, {}), null);
  // 入参缺失
  assert.equal(calibrationFromTwoPoints(null, null, opts), null);
});

/* ========================================================================== */
/* formatCoords / fmtBlock                                                     */
/* ========================================================================== */

test('formatCoords：世界坐标格式化为「X Y Z」整数', () => {
  assert.equal(formatCoords({ x: 123.4, y: 64.6, z: -44.6 }), '123 65 -45');
  assert.equal(formatCoords({ x: 0, y: 0, z: 0 }), '0 0 0');
  assert.equal(formatCoords({ x: -1792.7, y: 12, z: 2560.2 }), '-1793 12 2560');
  // y 可空（路径点的 y 允许省略）
  assert.equal(formatCoords({ x: 123.4, z: -44.6 }), '123 -45');
  assert.equal(formatCoords({ x: 123.4, y: null, z: -44.6 }), '123 -45');
  // 非法值降级为破折号，不抛异常
  assert.equal(formatCoords({}), '— —');
  assert.equal(formatCoords(), '— —');
});

test('fmtBlock：四舍五入取整字符串，非法值返回破折号', () => {
  assert.equal(fmtBlock(3.5), '4');
  assert.equal(fmtBlock(3.4), '3');
  assert.equal(fmtBlock(-3.5), '-3'); // JS Math.round 向 +∞ 取整
  assert.equal(fmtBlock(-0.4), '0'); // 不出现 "-0"
  assert.equal(fmtBlock(64), '64');
  assert.equal(fmtBlock('12.7'), '13');
  assert.equal(fmtBlock(NaN), '—');
  assert.equal(fmtBlock(Infinity), '—');
  assert.equal(fmtBlock(null), '—');
  assert.equal(fmtBlock(undefined), '—');
  assert.equal(fmtBlock(''), '—');
  assert.equal(fmtBlock('abc'), '—');
});

/* ========================================================================== */
/* distanceXZ                                                                  */
/* ========================================================================== */

test('distanceXZ：XZ 平面欧氏距离，忽略 Y', () => {
  assert.equal(distanceXZ({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
  assert.equal(distanceXZ({ x: 3, z: 4 }, { x: 0, z: 0 }), 5); // 对称
  assert.equal(distanceXZ({ x: 10, z: 10 }, { x: 10, z: 10 }), 0);
  // y 不参与计算
  assert.equal(distanceXZ({ x: 0, y: 100, z: 0 }, { x: 3, y: -50, z: 4 }), 5);
  closeTo(distanceXZ({ x: -1792, z: -2560 }, { x: 1792, z: 2560 }), Math.hypot(3584, 5120), 1e-9, '大跨度');
  // 非法入参 → 0（UI 不出现 NaN）
  assert.equal(distanceXZ(null, { x: 0, z: 0 }), 0);
  assert.equal(distanceXZ({ x: NaN, z: 0 }, { x: 0, z: 0 }), 0);
  assert.equal(distanceXZ({ x: 0 }, { x: 3, z: 4 }), 0);
});

/* ========================================================================== */
/* 整体联调：默认 config 画幅                                                  */
/* ========================================================================== */

test('联调：默认配置（1 像素 = 1 方块、中心为世界原点）能正确摆放路径点', () => {
  const cal = normalizeCalibration(
    { calibrated: false, xMin: -1792, xMax: 1792, zMin: -2560, zMax: 2560, flipZ: false },
    { imageWidth: 3584, imageHeight: 5120 },
  );
  assert.ok(cal);
  const p = createProjection({ ...cal, imageWidth: 3584, imageHeight: 5120 });
  assert.equal(p.isValid, true);

  // config.json 里的「出生点」在世界 (0, 0) → 图片正中心
  assert.deepEqual(p.worldToImage(0, 0), { px: 1792, py: 2560 });
  // 「远山观景台」在东侧、北侧 → 像素偏右上
  const mountain = p.worldToImage(1180, -980);
  assert.ok(mountain.px > 1792);
  assert.ok(mountain.py < 2560);
});
