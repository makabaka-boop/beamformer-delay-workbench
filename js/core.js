// core.js —— 纯函数核心，无 DOM / Worker 依赖，可直接在 Node 中测试。
//
// 延时语义：对轨道 cur 估计整数延时 d（采样）。
// 合成时输出位置 n 处取 cur[n - d]，因此：
//   d > 0：cur 相对基准延后 d 个采样（开头补零）
//   d < 0：cur 相对基准提前 |d| 个采样（结尾补零）
//
// 相关性窗口：以第一路前 WINDOW_SAMPLES 个采样为基准窗，
// score(d) = Σ ref[k] * cur[k - d]，k 取 0..WINDOW_SAMPLES-1。

export const MIN_TRACKS = 2;
export const MAX_TRACKS = 6;
export const WINDOW_SAMPLES = 4096;
export const MAX_LAG = 32;
export const GAIN_STEP = 0.25;
export const GAIN_MIN = 0;
export const GAIN_MAX = 4;

/** 校验延时是否为允许范围内的整数（采样）。 */
export function isValidDelay(d) {
  return Number.isInteger(d) && d >= -MAX_LAG && d <= MAX_LAG;
}

/** 增益量化到四分之一整数倍，并夹取到 [0, 4]。 */
export function quantizeGain(g) {
  const v = Number(g);
  if (!Number.isFinite(v)) return GAIN_MIN;
  const q = Math.round(v / GAIN_STEP) * GAIN_STEP;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, q));
}

/**
 * 单个延时位置的交叠逐样本乘积之和。
 * 仅统计 ref[k] 与 cur[k - lag] 同为有效索引的位置；无交叠返回 0。
 */
export function dotAtLag(ref, cur, lag, windowSize = WINDOW_SAMPLES) {
  const n = Math.min(windowSize, ref.length, cur.length + Math.max(0, lag));
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const j = k - lag;
    if (j >= 0 && j < cur.length) sum += ref[k] * cur[j];
  }
  return sum;
}

/** 并列比较：先取 |d| 最小，再取 d 数值最小。返回 a 严格优于 b。 */
function preferLag(a, b) {
  const aa = Math.abs(a);
  const bb = Math.abs(b);
  if (aa !== bb) return aa < bb;
  return a < b;
}

/**
 * 在 −32..32 个整数采样延时上穷举搜索相关性最大者。
 * 并列先取延时绝对值最小、再取延时数值最小。
 * 返回 { delay, scores }，scores 按下标 lag + MAX_LAG 存放。
 */
export function findBestDelay(ref, cur, {
  maxLag = MAX_LAG,
  windowSize = WINDOW_SAMPLES,
} = {}) {
  let bestDelay = 0;
  let bestScore = null;
  const scores = new Int32Array(2 * maxLag + 1);
  for (let d = -maxLag; d <= maxLag; d++) {
    const s = dotAtLag(ref, cur, d, windowSize);
    scores[d + maxLag] = s;
    if (bestScore === null || s > bestScore || (s === bestScore && preferLag(d, bestDelay))) {
      bestScore = s;
      bestDelay = d;
    }
  }
  return { delay: bestDelay, score: bestScore ?? 0, scores };
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/**
 * 四舍五入（半值向 +∞）后夹取到 PCM16 整数范围。
 * 先夹取再取整：饱和值本身不受舍入影响。
 */
export function saturateToInt16(x) {
  let v = Math.round(x); // -x.5 向正方向舍入
  if (v === 0) v = 0;    // 归一化 -0
  if (v > INT16_MAX) return INT16_MAX;
  if (v < INT16_MIN) return INT16_MIN;
  return v;
}

/** 合成输出长度：覆盖所有轨道 [delay, len + delay) 的采样范围。 */
export function mixOutputLength(tracks) {
  let end = 0;
  for (const t of tracks) end = Math.max(end, t.samples.length + (t.delay | 0));
  return end;
}

/**
 * 新建合成累加器（Float64）。outLen 为 0 时输出长度按轨道自动计算。
 */
export function createMixer(tracks, outLen) {
  const length = outLen ?? mixOutputLength(tracks);
  return { length, mix: new Float64Array(length) };
}

/**
 * 将一路轨道累加到合成缓冲；越界位置自然补零。
 * 每 checkEvery 个输出采样回调一次 shouldCancel()，返回 true 则中止并返回 false。
 * 正常完成返回 true。
 */
export function accumulateTrack(mixer, samples, delay, gain, shouldCancel, checkEvery = 65536) {
  const { mix, length } = mixer;
  const start = Math.max(0, delay);
  const end = Math.min(length, samples.length + delay);
  for (let n = start; n < end; n++) {
    mix[n] += samples[n - delay] * gain;
    if (shouldCancel && ((n & (checkEvery - 1)) === 0) && shouldCancel()) return false;
  }
  return true;
}

/** 将 Float64 合成缓冲截断到 PCM16 范围，返回 Int16Array。 */
export function saturateBuffer(mix) {
  const out = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) out[i] = saturateToInt16(mix[i]);
  return out;
}

/**
 * 逐样本合成。tracks: [{ samples: Int16Array, delay, gain }]
 * 输出长度取所有轨道 [delay, len+delay) 的并集，越界补零，最后截断到 PCM16。
 */
export function mixTracks(tracks, outLen) {
  const mixer = createMixer(tracks, outLen);
  for (const t of tracks) {
    accumulateTrack(mixer, t.samples, t.delay | 0, +t.gain, null);
  }
  return saturateBuffer(mixer.mix);
}

// ---------------------------------------------------------------------------
// WAV 解析（导入）与编码（下载）
// ---------------------------------------------------------------------------

/**
 * 解析单声道 PCM16 WAV。返回 { sampleRate, samples: Int16Array }。
 * 任何不符（非 RIFF/WAVE、非 PCM、非单声道、非 16bit、无 data 块）均抛错。
 */
export function parseWavPcm16(buffer) {
  const b = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const readStr = (o, len) => String.fromCharCode(...b.subarray(o, o + len));

  if (b.byteLength < 44 || readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('不是 WAV/RIFF 文件');
  }

  let fmt = null;
  let dataOff = -1;
  let dataSize = 0;
  let off = 12;
  while (off + 8 <= b.byteLength) {
    const id = readStr(off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (body + size > b.byteLength) throw new Error(`WAV ${id} 块长度越界`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('fmt 块过短');
      fmt = {
        audioFormat: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataSize = size;
    }
    off = body + size + (size & 1); // 块按字对齐，奇数长度补 1 字节
  }

  if (!fmt) throw new Error('缺少 fmt 块');
  if (fmt.audioFormat !== 1) throw new Error(`仅支持 PCM 格式（当前格式码 ${fmt.audioFormat}）`);
  if (fmt.channels !== 1) throw new Error(`仅支持单声道（当前 ${fmt.channels} 声道）`);
  if (fmt.bitsPerSample !== 16) throw new Error(`仅支持 16-bit PCM（当前 ${fmt.bitsPerSample}-bit）`);
  if (dataOff < 0) throw new Error('缺少 data 块');

  const frames = Math.min(dataSize, b.byteLength - dataOff) >> 1;
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(dataOff + i * 2, true);
  return { sampleRate: fmt.sampleRate, samples };
}

/**
 * 将单声道 Int16Array 编码为 16kHz… 任意采样率的 PCM16 WAV（Uint8Array）。
 */
export function encodeWavPcm16(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                 // PCM
  dv.setUint16(22, 1, true);                 // 单声道
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);    // 字节率
  dv.setUint16(32, 2, true);                 // 块对齐
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return u8;
}

// ---------------------------------------------------------------------------
// 防迟到结果的令牌门（主线程侧第二道保险）
// ---------------------------------------------------------------------------

export function createTokenGate(initial = 0) {
  let current = initial;
  return {
    next() { return ++current; },
    get current() { return current; },
    isCurrent(token) { return token === current; },
  };
}
