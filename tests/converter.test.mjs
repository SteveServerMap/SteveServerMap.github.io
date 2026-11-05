/**
 * tests/converter.test.mjs —— converter.js 纯函数的单元测试（node:test + node:assert）
 *
 * 运行：node --test tests/converter.test.mjs
 *
 * 覆盖范围：
 *   - overworldToNether / netherToOverworld：正算、负数、0、四舍五入、往返
 *   - 非法入参（null / 空串 / NaN / 非数字串）一律返回 null，不抛异常
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NETHER_SCALE, overworldToNether, netherToOverworld } from '../assets/js/converter.js';

test('主世界 → 下界：÷8 并四舍五入', () => {
  assert.equal(NETHER_SCALE, 8);
  assert.deepEqual(overworldToNether(8, -8), { x: 1, z: -1 });
  assert.deepEqual(overworldToNether(0, 0), { x: 0, z: 0 });
  // 12.5 → 13；-12.5 → -12（Math.round 负数半值向零取整，与 Java 一致）
  assert.deepEqual(overworldToNether(100, -100), { x: 13, z: -12 });
  // 0.5 → 1；-0.5 → -0（四舍五入）
  assert.deepEqual(overworldToNether(4, -4), { x: 1, z: -0 });
  assert.deepEqual(overworldToNether(3, -3), { x: 0, z: -0 }); // 0.375 → 0
});

test('下界 → 主世界：×8', () => {
  assert.deepEqual(netherToOverworld(1, -1), { x: 8, z: -8 });
  assert.deepEqual(netherToOverworld(0, 0), { x: 0, z: 0 });
  assert.deepEqual(netherToOverworld(-64, 320), { x: -512, z: 2560 });
});

test('往返换算回到原点（同一方向往返）', () => {
  const a = overworldToNether(1234, -5678);
  const b = netherToOverworld(a.x, a.z);
  // ÷8 再 ×8：误差在半个下界格（4 主世界格）内
  assert.ok(Math.abs(b.x - 1234) <= 4);
  assert.ok(Math.abs(b.z - (-5678)) <= 4);
});

test('字符串数字与 number 等价', () => {
  assert.deepEqual(overworldToNether('80', '-16'), { x: 10, z: -2 });
  assert.deepEqual(netherToOverworld('10', '10'), { x: 80, z: 80 });
});

test('非法入参一律返回 null，不抛异常', () => {
  assert.equal(overworldToNether(null, 8), null);
  assert.equal(overworldToNether(8, undefined), null);
  assert.equal(overworldToNether('', ''), null);
  assert.equal(overworldToNether(NaN, 0), null);
  assert.equal(overworldToNether(Infinity, 0), null);
  assert.equal(overworldToNether('abc', 8), null);
  assert.equal(netherToOverworld({}, 8), null);
  assert.equal(netherToOverworld(), null);
});
