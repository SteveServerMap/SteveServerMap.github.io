/**
 * tests/skin.test.mjs —— skin.js 纯函数的单元测试（node:test + node:assert）
 *
 * 运行：node --test tests/skin.test.mjs
 *
 * 覆盖范围：
 *   - normalizeSkinId：合法 / 非法 / 16 位边界 / 17 位越界 / 空白裁剪
 *   - skinProfileUrl：playerdb 档案地址与非法 ID 返回 null
 *   - skinUuidUrls：按 UUID 的多源列表（mineatar / mc-heads / minotar）与非法 UUID 返回 null
 *   - isSkinSize：64×64 / 128×128 / 旧版 64×32 / 128×64 合法，其余非法
 *   - legacyPatchRects 矩形表合法性（64×32 与 128×64 两档等比缩放、不越界）
 *   - padLegacySkin 入参守卫（Node 无 DOM 时返回 null，不抛异常）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIN_WIDTH,
  SKIN_HEIGHT,
  LEGACY_SKIN_HEIGHT,
  isSkinSize,
  normalizeSkinId,
  skinProfileUrl,
  skinUuidUrls,
  legacyPatchRects,
  LEGACY_PATCHES,
  padLegacySkin,
} from '../assets/js/skin.js';

test('normalizeSkinId：合法 ID 原样返回并裁剪空白', () => {
  assert.equal(normalizeSkinId('Steve'), 'Steve');
  assert.equal(normalizeSkinId('  Steve  '), 'Steve');
  assert.equal(normalizeSkinId('KobayashiNana'), 'KobayashiNana');
  assert.equal(normalizeSkinId('a_1'), 'a_1');
  assert.equal(normalizeSkinId('0123456789abcdef'), '0123456789abcdef'); // 16 位边界
});

test('normalizeSkinId：非法输入返回 null，不抛异常', () => {
  assert.equal(normalizeSkinId(''), null);
  assert.equal(normalizeSkinId('   '), null);
  assert.equal(normalizeSkinId('0123456789abcdefg'), null); // 17 位越界
  assert.equal(normalizeSkinId('a-b'), null); // 连字符
  assert.equal(normalizeSkinId('a.b'), null);
  assert.equal(normalizeSkinId('中文'), null);
  assert.equal(normalizeSkinId('a b'), null); // 内部空格
  assert.equal(normalizeSkinId(null), null);
  assert.equal(normalizeSkinId(undefined), null);
  assert.equal(normalizeSkinId(123), null);
});

test('skinProfileUrl：playerdb 档案地址（名称→UUID），非法 ID 返回 null', () => {
  assert.equal(
    skinProfileUrl('Steve'),
    'https://playerdb.co/api/player/minecraft/Steve',
  );
  assert.equal(
    skinProfileUrl('  Steve  '),
    'https://playerdb.co/api/player/minecraft/Steve',
  );
  assert.equal(skinProfileUrl(''), null);
  assert.equal(skinProfileUrl('a b'), null);
  assert.equal(skinProfileUrl(null), null);
});

test('skinUuidUrls：按 UUID 生成多源列表（mineatar / mc-heads / minotar），非法 UUID 返回 null', () => {
  const uuid = '86f248f609734188b249ff451cb33040';
  assert.deepEqual(skinUuidUrls(uuid), [
    { name: 'mineatar', url: `https://api.mineatar.io/skin/${uuid}.png` },
    { name: 'mc-heads', url: `https://mc-heads.net/skin/${uuid}.png` },
    { name: 'minotar', url: `https://minotar.net/skin/${uuid}.png` },
  ]);
  // 大小写 UUID 均可
  assert.deepEqual(skinUuidUrls(uuid.toUpperCase())[0].name, 'mineatar');
  assert.equal(skinUuidUrls('86f248f609734188b249ff451cb3304'), null); // 31 位
  assert.equal(skinUuidUrls('86f248f6-0973-4188-b249-ff451cb33040'), null); // 带连字符
  assert.equal(skinUuidUrls(''), null);
  assert.equal(skinUuidUrls(null), null);
  assert.equal(skinUuidUrls(123), null);
});

test('isSkinSize：64×64 / 128×128 与旧版 64×32 / 128×64 合法，其余非法', () => {
  assert.equal(isSkinSize(SKIN_WIDTH, SKIN_HEIGHT), true);
  assert.equal(isSkinSize(SKIN_WIDTH, LEGACY_SKIN_HEIGHT), true);
  assert.equal(isSkinSize(128, 128), true);
  assert.equal(isSkinSize(128, 64), true);
  assert.equal(isSkinSize(64, 48), false);
  assert.equal(isSkinSize(32, 64), false);
  assert.equal(isSkinSize(127, 127), false);
  assert.equal(isSkinSize(256, 256), false); // 暂只支持到 128
  assert.equal(isSkinSize(128, 32), false);
  assert.equal(isSkinSize(0, 0), false);
  assert.equal(isSkinSize(NaN, 64), false);
});

test('LEGACY_PATCHES：第一块覆盖整个上半，肢体补全块源与目标均不越界', () => {
  assert.ok(LEGACY_PATCHES.length >= 3);
  // 第一块：64×32 整体 → (0,0)
  const head = LEGACY_PATCHES[0];
  assert.deepEqual(
    { sx: head.sx, sy: head.sy, sw: head.sw, sh: head.sh },
    { sx: 0, sy: 0, sw: 64, sh: 32 },
  );
  for (const p of LEGACY_PATCHES) {
    // 源矩形必须在旧版 64×32 画布内
    assert.ok(p.sx >= 0 && p.sy >= 0, '源坐标非负');
    assert.ok(p.sx + p.sw <= 64, `源 x 越界：${p.sx}+${p.sw}`);
    assert.ok(p.sy + p.sh <= 32, `源 y 越界：${p.sy}+${p.sh}`);
    // 目标矩形必须在 64×64 画布内
    assert.ok(p.dx >= 0 && p.dy >= 0, '目标坐标非负');
    assert.ok(p.dx + p.sw <= 64, `目标 x 越界：${p.dx}+${p.sw}`);
    assert.ok(p.dy + p.sh <= 64, `目标 y 越界：${p.dy}+${p.sh}`);
    assert.ok(p.sw > 0 && p.sh > 0, '尺寸为正');
  }
  // 肢体补全块：源为右腿/右臂（y=20..32），目标为左腿/左臂基座（y=52..64）
  const limbs = LEGACY_PATCHES.slice(1);
  assert.equal(limbs.length, 2);
  for (const p of limbs) {
    assert.equal(p.sy, 20);
    assert.equal(p.dy, 52);
    assert.equal(p.sw, 16);
    assert.equal(p.sh, 12);
  }
  // 目标块 x 互不重叠（左腿 16、左臂 32）
  assert.deepEqual(limbs.map((p) => p.dx).sort((a, b) => a - b), [16, 32]);
});

test('legacyPatchRects：128×64 为 64×32 的等比 2 倍缩放，非法尺寸返回 null', () => {
  const r128 = legacyPatchRects(128, 64);
  assert.ok(r128, '128×64 应有矩形表');
  const r64 = legacyPatchRects(64, 32);
  for (let i = 0; i < r64.length; i++) {
    for (const key of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy']) {
      assert.equal(r128[i][key], r64[i][key] * 2, `第 ${i} 块 ${key} 应为 2 倍`);
    }
  }
  // 128 档不越界：源在 128×64 内、目标在 128×128 内
  for (const p of r128) {
    assert.ok(p.sx >= 0 && p.sy >= 0 && p.dx >= 0 && p.dy >= 0, '坐标非负');
    assert.ok(p.sx + p.sw <= 128 && p.sy + p.sh <= 64, '源不越界');
    assert.ok(p.dx + p.sw <= 128 && p.dy + p.sh <= 128, '目标不越界');
    assert.ok(p.sw > 0 && p.sh > 0, '尺寸为正');
  }
  assert.equal(legacyPatchRects(64, 64), null); // 正方形不是旧版
  assert.equal(legacyPatchRects(128, 128), null);
  assert.equal(legacyPatchRects(96, 48), null); // 96 档不支持
  assert.equal(legacyPatchRects(0, 0), null);
  assert.equal(legacyPatchRects(NaN, NaN), null);
  assert.equal(legacyPatchRects('64', 32), null);
});

test('padLegacySkin：非法入参与无 DOM 环境返回 null，不抛异常', () => {
  assert.equal(padLegacySkin(null), null);
  assert.equal(padLegacySkin(undefined), null);
  assert.equal(padLegacySkin({ width: 0, height: 0 }), null);
  assert.equal(padLegacySkin({ width: 64, height: 64 }), null); // 非旧版尺寸
  assert.equal(padLegacySkin({ width: 96, height: 48 }), null); // 96 档不支持
  // Node 环境没有 document → 尺寸正确的入参也返回 null（补全只能在浏览器执行）
  assert.equal(padLegacySkin({ width: 64, height: 32 }), null);
  assert.equal(padLegacySkin({ width: 128, height: 64 }), null);
});
