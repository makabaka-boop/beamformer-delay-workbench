// test/engine.test.js —— 用确定性调度器测试取消竞争、迟到结果丢弃、重新导入顶替。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../js/engine.js';

const I16 = (arr) => Int16Array.from(arr);

// 手动时钟：yield 返回的 promise 在 pump() 中被统一放行，
// 所有交错顺序因此完全确定，不依赖真实定时器。
function makeHarness() {
  const posts = [];
  const resolvers = [];
  const yieldFn = () => new Promise((resolve) => resolvers.push(resolve));
  const engine = createEngine({ post: (m) => posts.push(m), yieldFn });

  async function pump(times = 1) {
    for (let i = 0; i < times; i++) {
      const batch = resolvers.splice(0);
      batch.forEach((r) => r());
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  const byType = (type) => posts.filter((m) => m.type === type);
  return { engine, posts, pump, byType };
}

function trackPair(len = 200, shift = 0) {
  const ref = I16(Array.from({ length: len }, (_, i) => ((i * 37) % 101) - 50));
  const cur = new Int16Array(len);
  for (let i = 0; i < len; i++) cur[i] = ref[i - shift] ?? 0;
  return [ref, cur];
}

test('分析结果正确：第 0 路恒为 0，其余为穷举延时', async () => {
  const { engine, posts, pump, byType } = makeHarness();
  const [ref, cur] = trackPair(300, 3);
  engine.handleMessage({ type: 'load', token: 1, sampleRate: 8000, tracks: [{ samples: ref }, { samples: cur }] });
  engine.handleMessage({ type: 'analyze', token: 2 });
  await pump(10);

  assert.equal(byType('tracksLoaded').length, 1);
  assert.equal(byType('tracksLoaded')[0].token, 1);
  const analyzed = byType('analyzed');
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0].token, 2);
  assert.equal(analyzed[0].delays[0], 0);
  // cur[j]=ref[j-3]（晚到 3 采样）→ 估计 d=-3
  assert.equal(analyzed[0].delays[1], -3);
  assert.ok(posts.every((m) => m.token <= 2));
});

test('取消竞争：重新导入前连续发起两次分析，旧分析绝不回发结果', async () => {
  const { engine, posts, pump, byType } = makeHarness();
  const [r1, c1] = trackPair(100, 1);
  const [r2, c2] = trackPair(100, 2);

  engine.handleMessage({ type: 'load', token: 10, sampleRate: 8000, tracks: [{ samples: r1 }, { samples: c1 }] });
  engine.handleMessage({ type: 'analyze', token: 11 });
  // load 尚未开始时再次导入 + 分析（最激进的顶替）
  engine.handleMessage({ type: 'load', token: 20, sampleRate: 8000, tracks: [{ samples: r2 }, { samples: c2 }] });
  engine.handleMessage({ type: 'analyze', token: 21 });
  assert.equal(engine.hasPendingLoad, true);
  assert.equal(engine.pendingOpType, 'analyze');

  await pump(20);

  // 只有 token 21 的分析落地；11 号迟到结果被丢弃
  const analyzed = byType('analyzed');
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0].token, 21);
  assert.equal(analyzed[0].delays[1], -2);
  assert.ok(!posts.some((m) => m.token === 11 && m.type === 'analyzed'));
  // 两次 load 回执：10 号 load 在开始前即被顶替，不回发
  const loads = byType('tracksLoaded');
  assert.deepEqual(loads.map((m) => m.token), [20]);
});

test('取消竞争：分析进行到中途被新分析顶替，旧结果不得回发', async () => {
  const { engine, posts, pump, byType } = makeHarness();
  const tracks = [trackPair(64, 0)[0]];
  // 4 路，后三路分别植入不同移位
  const shifts = [0, 4, -5, 2];
  for (let i = 1; i < 4; i++) {
    const c = new Int16Array(64);
    for (let j = 0; j < 64; j++) c[j] = tracks[0][j - shifts[i]] ?? 0;
    tracks.push(c);
  }
  engine.handleMessage({ type: 'load', token: 1, sampleRate: 8000, tracks: tracks.map((s) => ({ samples: s })) });
  engine.handleMessage({ type: 'analyze', token: 2 });
  await pump(3); // load 完成；分析 2 完成第 1 路（基准）并停在第 2 路前的 yield

  engine.handleMessage({ type: 'analyze', token: 3 }); // 中途顶替
  await pump(20);

  const analyzed = byType('analyzed');
  assert.equal(analyzed.length, 1, '被取消的分析不得回发结果');
  assert.equal(analyzed[0].token, 3);
  // cur[j]=ref[j-shift] 约定：shift=4→d=-4, shift=-5→d=+5, shift=2→d=-2
  assert.deepEqual(Array.from(analyzed[0].delays), [0, -4, 5, -2]);
});

test('取消竞争：合成中途被新参数顶替，旧合成缓冲不得回发', async () => {
  const { engine, byType, pump } = makeHarness();
  const [ref, cur] = trackPair(500, 0);
  engine.handleMessage({ type: 'load', token: 1, sampleRate: 8000, tracks: [{ samples: ref }, { samples: cur }] });
  engine.handleMessage({
    type: 'synthesize', token: 2,
    params: [{ delay: 0, gain: 1 }, { delay: 0, gain: 1 }],
  });
  await pump(2); // load 完成；合成 2 停在第 1 路累加前

  engine.handleMessage({
    type: 'synthesize', token: 3,
    params: [{ delay: 0, gain: 1 }, { delay: 0, gain: 0 }], // 第二路静音
  });
  await pump(20);

  const mixed = byType('mixed');
  assert.equal(mixed.length, 1, '旧合成不得回发');
  assert.equal(mixed[0].token, 3);
  // 只保留第一路
  assert.deepEqual(Array.from(mixed[0].samples.slice(0, 5)), Array.from(ref.slice(0, 5)));
});

test('重新导入顶替进行中的合成，迟到混合结果不落地', async () => {
  const { engine, byType, pump } = makeHarness();
  const [r1, c1] = trackPair(300, 1);
  const [r2, c2] = trackPair(100, 6);

  engine.handleMessage({ type: 'load', token: 1, sampleRate: 8000, tracks: [{ samples: r1 }, { samples: c1 }] });
  engine.handleMessage({ type: 'synthesize', token: 2, params: [{ delay: 0, gain: 1 }, { delay: -1, gain: 1 }] });
  await pump(2); // 合成 2 停在第 1 轨前

  // 真实主线程时序：重新导入 + 分析先完成，之后用户按新数据发起合成
  engine.handleMessage({ type: 'load', token: 3, sampleRate: 8000, tracks: [{ samples: r2 }, { samples: c2 }] });
  engine.handleMessage({ type: 'analyze', token: 4 });
  await pump(12);
  assert.equal(byType('analyzed').length, 1);
  assert.equal(byType('analyzed')[0].token, 4);

  engine.handleMessage({ type: 'synthesize', token: 5, params: [{ delay: 0, gain: 1 }, { delay: -6, gain: 1 }] });
  await pump(12);

  const mixed = byType('mixed');
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].token, 5);
  assert.equal(mixed[0].samples.length, 100); // 新导入的长度
  assert.equal(byType('analyzed')[0].delays[1], -6);
  assert.ok(!byType('mixed').some((m) => m.token === 2));
});

test('未导入即合成 → 回发 error 而非崩溃', async () => {
  const { engine, byType, pump } = makeHarness();
  engine.handleMessage({ type: 'synthesize', token: 9, params: [] });
  await pump(5);
  const errors = byType('error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].token, 9);
});

test('合成：负延时端点补零与饱和结果正确', async () => {
  const { engine, byType, pump } = makeHarness();
  engine.handleMessage({
    type: 'load', token: 1, sampleRate: 8000,
    tracks: [{ samples: I16([20000, 20000, 20000]) }, { samples: I16([20000, 20000, 20000, 20000]) }],
  });
  engine.handleMessage({
    type: 'synthesize', token: 2,
    params: [{ delay: 0, gain: 1 }, { delay: -1, gain: 1 }],
  });
  await pump(10);
  const mixed = byType('mixed');
  assert.equal(mixed.length, 1);
  // n0: 20000+cur[1]=40000→饱和；n1 同；n2 同；长度 max(3,4-1)=3
  assert.deepEqual(Array.from(mixed[0].samples), [32767, 32767, 32767]);
});
