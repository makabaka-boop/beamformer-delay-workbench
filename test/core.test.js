// test/core.test.js —— 穷举相关性、并列规则、负延时、端点补零、饱和、WAV 编解码、令牌门。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LAG, WINDOW_SAMPLES,
  quantizeGain, isValidDelay,
  dotAtLag, findBestDelay,
  saturateToInt16, mixOutputLength, mixTracks,
  parseWavPcm16, encodeWavPcm16,
  createTokenGate,
} from '../js/core.js';

const I16 = (arr) => Int16Array.from(arr);

test('dotAtLag：短数组逐位置手算', () => {
  const ref = I16([1, 2, 3]);
  const cur = I16([4, 5, 6]);
  assert.equal(dotAtLag(ref, cur, 0, 8), 1 * 4 + 2 * 5 + 3 * 6);   // 32
  assert.equal(dotAtLag(ref, cur, 1, 8), 2 * 4 + 3 * 5);           // 23，k=0 越界
  assert.equal(dotAtLag(ref, cur, -1, 8), 1 * 5 + 2 * 6);          // 17，k=2 越界
  assert.equal(dotAtLag(ref, cur, 3, 8), 0);                       // 完全无交叠
  assert.equal(dotAtLag(ref, cur, -3, 8), 0);
});

test('dotAtLag：窗口只取前 windowSize 个基准采样', () => {
  const ref = I16([10, 0, 0, 0]);
  const cur = I16([10, 0, 0, 0]);
  assert.equal(dotAtLag(ref, cur, 0, 1), 100);
  assert.equal(dotAtLag(ref, cur, 1, 1), 0); // 窗口只有 ref[0]，d=1 时 cur[-1] 越界
});

// 独立参考实现：与 findBestDelay 做穷举对照
function referenceSearch(ref, cur, maxLag, windowSize) {
  let best = { d: 0, s: null };
  for (let d = -maxLag; d <= maxLag; d++) {
    let s = 0;
    for (let k = 0; k < Math.min(windowSize, ref.length); k++) {
      const j = k - d;
      if (j >= 0 && j < cur.length) s += ref[k] * cur[j];
    }
    const worse = best.s === null
      || s > best.s
      || (s === best.s && (Math.abs(d) < Math.abs(best.d) || (Math.abs(d) === Math.abs(best.d) && d < best.d)));
    if (worse) best = { d, s };
  }
  return best;
}

test('findBestDelay：短数组穷举与参考实现一致（含随机数据）', () => {
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  for (let iter = 0; iter < 300; iter++) {
    const refLen = 1 + Math.floor(rnd() * 12);
    const curLen = 1 + Math.floor(rnd() * 12);
    const maxLag = 1 + Math.floor(rnd() * 3);
    const win = 1 + Math.floor(rnd() * 14);
    const ref = I16(Array.from({ length: refLen }, () => Math.floor(rnd() * 7) - 3));
    const cur = I16(Array.from({ length: curLen }, () => Math.floor(rnd() * 7) - 3));

    const got = findBestDelay(ref, cur, { maxLag, windowSize: win });
    const want = referenceSearch(ref, cur, maxLag, win);
    assert.equal(got.delay, want.d, `iter ${iter}: delay ref=${ref} cur=${cur}`);
    assert.equal(got.score, want.s);
    assert.equal(got.scores.length, 2 * maxLag + 1);
    for (let d = -maxLag; d <= maxLag; d++) assert.equal(got.scores[d + maxLag], want.d === d ? want.s : got.scores[d + maxLag]);
  }
});

test('并列规则：全零时取延时 0（绝对值最小）', () => {
  const ref = I16(new Array(20).fill(0));
  const cur = I16(new Array(20).fill(0));
  const r = findBestDelay(ref, cur, { maxLag: 4, windowSize: 20 });
  assert.equal(r.delay, 0);
  assert.equal(r.score, 0);
  assert.ok(r.scores.every((v) => v === 0));
});

test('并列规则：d=−1 与 d=+1 同分时取数值更小的 −1', () => {
  // ref=[1,-1], cur=[-1,1]：d=-1 与 d=+1 各得 1，d=0 得 −2
  const r = findBestDelay(I16([1, -1]), I16([-1, 1]), { maxLag: 1, windowSize: 4 });
  assert.equal(r.delay, -1);
  assert.equal(r.scores[0], 1); // d=-1
  assert.equal(r.scores[1], -2); // d=0
  assert.equal(r.scores[2], 1);  // d=+1
});

test('并列规则：|d| 不同时优先绝对值更小者', () => {
  // ref=[1,0,0], cur=[0,1,0]
  // d=0:0  d=1: ref1*cur0=0  d=-1: ref0*cur1=1  d=2: ref2*cur0=0
  // 0 分出现在 d=0,d=1,d=2；最高分 d=-1，不构成并列；再造纯零尾：
  const ref = I16([1, 0, 0, 0]);
  const cur = I16([0, 0, 0, 0]);
  const r = findBestDelay(ref, cur, { maxLag: 2, windowSize: 4 });
  assert.equal(r.delay, 0); // 全部 0 分 → |0|
});

test('植入正/负延时：仅前 4096 采样决定结果，且合成后重新对齐', () => {
  const N = 5000;
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ref = I16(Array.from({ length: N }, () => Math.floor(rnd() * 2000) - 1000));
  const L = 7;

  // cur 比基准“晚到” L 个采样：cur[j]=ref[j-L]（前补零）→ 应估出 d=−L
  const late = new Int16Array(N);
  for (let j = L; j < N; j++) late[j] = ref[j - L];
  assert.equal(findBestDelay(ref, late).delay, -L);

  // cur 比基准“提前” L 个采样：cur[j]=ref[j+L]（尾补零）→ 应估出 d=+L
  const early = new Int16Array(N);
  for (let j = 0; j < N - L; j++) early[j] = ref[j + L];
  assert.equal(findBestDelay(ref, early).delay, L);

  // 用估出的延时合成，前 4096 窗口内应逐样本重新对齐（忽略端点）
  const alignedLate = mixTracks(
    [{ samples: ref, delay: 0, gain: 1 }, { samples: late, delay: -L, gain: 1 }],
  );
  for (let n = 0; n < WINDOW_SAMPLES; n++) {
    assert.ok(Math.abs(alignedLate[n] - 2 * ref[n]) <= 1, `late align @${n}`);
  }
  const alignedEarly = mixTracks(
    [{ samples: ref, delay: 0, gain: 1 }, { samples: early, delay: L, gain: 1 }],
  );
  // 输出长度 N+L；[0,L) 仅基准（开头补零）；[L,N) 两轨对齐：out[k]=2·ref[k]
  assert.equal(alignedEarly.length, N + L);
  for (let k = L; k < N; k++) {
    assert.ok(Math.abs(alignedEarly[k] - 2 * ref[k]) <= 1, `early align @${k}`);
  }
  for (let n = 0; n < L; n++) assert.equal(alignedEarly[n], ref[n], `early 开头仅基准 @${n}`);
});

test('搜索只看前 4096 采样：头部对齐、尾部错位时结果为 0', () => {
  const ref = I16(Array.from({ length: 4096 }, (_, i) => (i < 4096 ? (i % 7) - 3 : 0)));
  const cur = Int16Array.from(ref);
  // 在 4096 之后制造错位（不影响窗口）
  for (let i = 4096; i < cur.length; i++) cur[i] = -cur[i];
  assert.equal(findBestDelay(ref, cur).delay, 0);
});

test('常量与范围', () => {
  assert.equal(MAX_LAG, 32);
  assert.equal(WINDOW_SAMPLES, 4096);
  assert.ok(isValidDelay(-32) && isValidDelay(32) && isValidDelay(0));
  assert.ok(!isValidDelay(-33) && !isValidDelay(33) && !isValidDelay(1.5));

  assert.equal(quantizeGain(0.3), 0.25);
  assert.equal(quantizeGain(0.124), 0);
  assert.equal(quantizeGain(0.125), 0.25);
  assert.equal(quantizeGain(3.9), 4);
  assert.equal(quantizeGain(9), 4);
  assert.equal(quantizeGain(-1), 0);
  assert.equal(quantizeGain('nope'), 0);
  assert.equal(quantizeGain('1.25'), 1.25);
});

test('saturateToInt16：半值向 +∞ 舍入并夹取', () => {
  assert.equal(saturateToInt16(0.4), 0);
  assert.equal(saturateToInt16(0.5), 1);
  assert.equal(saturateToInt16(-0.5), 0);   // 半值向正方向
  assert.equal(saturateToInt16(-1.5), -1);
  assert.equal(saturateToInt16(32767), 32767);
  assert.equal(saturateToInt16(32767.5), 32767);  // 先舍入 32768 → 饱和
  assert.equal(saturateToInt16(1e9), 32767);
  assert.equal(saturateToInt16(-32768), -32768);
  assert.equal(saturateToInt16(-32769.5), -32768);
  assert.equal(saturateToInt16(-1e9), -32768);
});

test('mixTracks：基本逐样本相加', () => {
  const out = mixTracks([
    { samples: I16([100, 200, 300]), delay: 0, gain: 1 },
    { samples: I16([50, 60, 70]), delay: 0, gain: 1 },
  ]);
  assert.deepEqual(Array.from(out), [150, 260, 370]);
});

test('mixTracks：负延时丢弃越界头部（端点补零）', () => {
  const out = mixTracks([
    { samples: I16([10, 20, 30]), delay: 0, gain: 1 },
    { samples: I16([1, 2, 3, 4, 5]), delay: -2, gain: 1 },
  ]);
  // 长度 = max(3, 5-2)=3；n0=10+cur[2]=13 …
  assert.equal(out.length, 3);
  assert.deepEqual(Array.from(out), [13, 24, 35]);
});

test('mixTracks：正延时尾部补零', () => {
  const out = mixTracks([
    { samples: I16([10, 20, 30]), delay: 0, gain: 1 },
    { samples: I16([1, 2, 3]), delay: 2, gain: 1 },
  ]);
  assert.equal(out.length, 5);
  assert.deepEqual(Array.from(out), [10, 20, 31, 2, 3]);
});

test('mixTracks：仅正延时轨开头补零、输出取最大跨度', () => {
  const out = mixTracks([{ samples: I16([7, 8]), delay: 3, gain: 1 }]);
  assert.deepEqual(Array.from(out), [0, 0, 0, 7, 8]);
  assert.equal(mixOutputLength([{ samples: new Int16Array(0), delay: 0 }]), 0);
});

test('mixTracks：四分之一整数倍增益精确生效', () => {
  const out = mixTracks([
    { samples: I16([10000, -10000, 400]), delay: 0, gain: 0.25 },
    { samples: I16([10000, -10000, 400]), delay: 0, gain: 1.25 },
  ]);
  assert.deepEqual(Array.from(out), [15000, -15000, 600]);
});

test('mixTracks：正负两端饱和', () => {
  const out = mixTracks([
    { samples: I16([30000, -30000, 32767, -32768]), delay: 0, gain: 1 },
    { samples: I16([30000, -30000, 10, -10]), delay: 0, gain: 1 },
  ]);
  assert.deepEqual(Array.from(out), [32767, -32768, 32767, -32768]);
});

test('mixTracks：空输入给出空缓冲', () => {
  const out = mixTracks([]);
  assert.ok(out instanceof Int16Array);
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

function buildWav({ channels = 1, bitsPerSample = 16, audioFormat = 1, sampleRate = 48000, samples, extra = [] }) {
  const bps = bitsPerSample >> 3;
  const data = samples
    ? new Uint8Array(samples.length * (bitsPerSample === 16 ? 2 : 1))
    : new Uint8Array(0);
  const dv = new DataView(data.buffer);
  if (samples && bitsPerSample === 16) samples.forEach((v, i) => dv.setInt16(i * 2, v, true));
  const fmtSize = 16;
  const total = 44 + data.length + extra.length;
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const w = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) w.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); w.setUint32(4, total - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); w.setUint32(16, fmtSize, true);
  w.setUint16(20, audioFormat, true);
  w.setUint16(22, channels, true);
  w.setUint32(24, sampleRate, true);
  w.setUint32(28, sampleRate * channels * bps, true);
  w.setUint16(32, channels * bps, true);
  w.setUint16(34, bitsPerSample, true);
  str(36, 'data'); w.setUint32(40, data.length, true);
  u8.set(data, 44);
  u8.set(extra, 44 + data.length);
  return buf;
}

test('WAV：编码后解析往返一致（含奇数长度 data）', () => {
  const samples = I16([0, 1, -1, 32767, -32768, 12345, -23456, 7]);
  const wav = encodeWavPcm16(samples, 44100);
  const parsed = parseWavPcm16(wav.buffer);
  assert.equal(parsed.sampleRate, 44100);
  assert.deepEqual(Array.from(parsed.samples), Array.from(samples));
});

test('WAV：拒绝非 RIFF / 立体声 / 非 16bit / 非 PCM', () => {
  assert.throws(() => parseWavPcm16(new ArrayBuffer(10)), /WAV/);
  assert.throws(() => parseWavPcm16(buildWav({ channels: 2, samples: [1, 2, 3, 4] })), /单声道/);
  assert.throws(() => parseWavPcm16(buildWav({ bitsPerSample: 24, samples: [1, 2, 3] })), /16-bit/);
  assert.throws(() => parseWavPcm16(buildWav({ audioFormat: 3, samples: [1, 2] })), /PCM/);

  const noData = buildWav({});
  // 抠掉 data 块头
  const trimmed = noData.slice(0, 36);
  new Uint8Array(trimmed).fill(0, 12); // 同时破坏 fmt
  assert.throws(() => parseWavPcm16(trimmed));
});

// ---------------------------------------------------------------------------
// 令牌门
// ---------------------------------------------------------------------------

test('TokenGate：迟到令牌一律判旧', () => {
  const gate = createTokenGate();
  const t1 = gate.next();
  assert.equal(t1, 1);
  assert.ok(gate.isCurrent(t1));
  const t2 = gate.next();
  assert.ok(!gate.isCurrent(t1)); // t1 已迟到
  assert.ok(gate.isCurrent(t2));
  gate.next();
  assert.ok(!gate.isCurrent(t2));
});
