/*
 * core.js —— 纯算法与编解码核心（无 DOM 依赖）
 *
 * 同时支持：
 *   - 浏览器：<script> 引入后挂到全局 self.PcmCore
 *   - Web Worker：importScripts('core.js')
 *   - Node：require('./core.js')
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PcmCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 延时搜索范围：[-MAX_DELAY, +MAX_DELAY]（整数采样） */
  const MAX_DELAY = 32;
  /** 相关分析只取每路开头至多 WINDOW 个采样 */
  const WINDOW = 4096;
  /** 增益粒度：1/4（0.25） */
  const GAIN_STEP = 0.25;

  /**
   * 单路相对基准路在指定整数延时 d 下的相关性。
   *
   * 约定 d > 0 表示 track 相对 reference 晚到 d 个采样（track 整体右移）。
   * 对齐关系为 output[n] = reference[n] + track[n - d]，
   * 交叠区间即两边下标同时合法：
   *   reference 下标 n    ∈ [0, rLen)
   *   track     下标 n-d  ∈ [0, tLen)
   * 交叠区内逐样本乘积直接求和（不做归一化）；无交叠时为 0。
   */
  function correlationAt(reference, track, d) {
    const rLen = reference.length;
    const tLen = track.length;
    // n ∈ [max(0,d), min(rLen, tLen+d))
    const nStart = d > 0 ? d : 0;
    const nEnd = Math.min(rLen, tLen + d);
    let sum = 0;
    for (let n = nStart; n < nEnd; n++) {
      sum += reference[n] * track[n - d];
    }
    return sum;
  }

  /** 候选 (score,d) 是否优于当前最优：分数高 → |d| 小 → d 小 */
  function isBetter(score, d, bestScore, bestD) {
    if (score !== bestScore) return score > bestScore;
    if (Math.abs(d) !== Math.abs(bestD)) return Math.abs(d) < Math.abs(bestD);
    return d < bestD;
  }

  /**
   * 在 [-32,+32] 上穷举相关性，取最大者。
   * 并列裁决：先取 |d| 最小，再取 d 数值最小（即负向优先）。
   */
  function findBestDelay(reference, track, maxDelay) {
    if (maxDelay == null) maxDelay = MAX_DELAY;
    let bestD = -maxDelay;
    let bestScore = correlationAt(reference, track, bestD);
    for (let d = -maxDelay + 1; d <= maxDelay; d++) {
      const score = correlationAt(reference, track, d);
      if (isBetter(score, d, bestScore, bestD)) {
        bestScore = score;
        bestD = d;
      }
    }
    return bestD;
  }

  /** 用前 WINDOW 个采样搜索各路相对基准的延时 */
  function analyze(tracks, maxDelay) {
    const ref = tracks[0].subarray(0, WINDOW);
    const delays = [0];
    for (let i = 1; i < tracks.length; i++) {
      delays.push(findBestDelay(ref, tracks[i].subarray(0, WINDOW), maxDelay));
    }
    return delays;
  }

  /** 四分之一整数倍量化：0.3 -> 0.25，0.9 -> 1.0 */
  function quantizeGain(value) {
    const q = Math.round(Number(value) * 4) / 4;
    if (!Number.isFinite(q)) return 1;
    return q;
  }

  /**
   * 逐样本混音。
   *
   * 输出起点固定在基准路（第 0 路）起点 0；轨道 d_j 为相对基准的延时
   *（d_j > 0 右移，d_j < 0 左移）。长度
   *     L = max(0, max_j(d_j + len_j))
   * 第 j 路贡献 samples_j[n-d_j]*g_j，下标越界处按零处理（补零）；
   * 起点早于 0 的采样（n<0）落在缓冲之外，即被裁掉。
   * 最终四舍五入并截断到 PCM16 [-32768,32767]（饱和）。
   *
   * signal（可选）：{ cancelled: boolean }，用于 Worker 协作式取消；
   * 不传时即纯同步函数，方便测试。
   */
  async function mixTracks(tracks, delays, gains, signal) {
    let L = 0;
    for (let j = 0; j < tracks.length; j++) {
      const end = delays[j] + tracks[j].length;
      if (end > L) L = end;
    }
    if (L < 0) L = 0;

    const out = new Int16Array(L);
    if (L === 0 || tracks.length === 0) return out;

    const CHUNK = 2048;
    for (let n0 = 0; n0 < L; n0 += CHUNK) {
      if (signal && signal.cancelled) return null;
      const nLimit = Math.min(L, n0 + CHUNK);
      for (let n = n0; n < nLimit; n++) {
        let acc = 0;
        for (let j = 0; j < tracks.length; j++) {
          const k = n - delays[j];
          if (k >= 0 && k < tracks[j].length) {
            acc += tracks[j][k] * gains[j];
          }
        }
        // 四舍五入（对负数为向远离零方向），再饱和截断
        const v = acc >= 0 ? Math.floor(acc + 0.5) : Math.ceil(acc - 0.5);
        out[n] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      }
      // 让出事件循环，使取消信号可被观察到
      if (nLimit < L) await yieldToEventLoop();
    }
    if (signal && signal.cancelled) return null;
    return out;
  }

  function yieldToEventLoop() {
    return new Promise(function (resolve) {
      if (typeof setImmediate === 'function') setImmediate(resolve);
      else setTimeout(resolve, 0);
    });
  }

  // ---------- WAV（PCM16 单声道）解析 / 编码 ----------

  /**
   * 解析 RIFF/WAVE 缓冲。仅接受：单声道、16bit、PCM(fmt=1)。
   * 返回 { sampleRate, samples: Int16Array }；samples 是数据拷贝，
   * 与原缓冲解耦。
   */
  function parseWav(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44) {
      throw new Error('不是有效的 WAV 文件（长度不足）');
    }
    const dv = new DataView(buffer);
    const readId = function (off) {
      return String.fromCharCode(
        dv.getUint8(off), dv.getUint8(off + 1),
        dv.getUint8(off + 2), dv.getUint8(off + 3)
      );
    };
    if (readId(0) !== 'RIFF' || readId(8) !== 'WAVE') {
      throw new Error('不是 RIFF/WAVE 文件');
    }
    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataLength = 0;
    while (offset + 8 <= buffer.byteLength) {
      const id = readId(offset);
      const size = dv.getUint32(offset + 4, true);
      const body = offset + 8;
      if (body + size > buffer.byteLength) {
        throw new Error('WAVE 块长度越界');
      }
      if (id === 'fmt ') {
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true)
        };
      } else if (id === 'data') {
        dataOffset = body;
        dataLength = size;
      }
      // 块按字对齐（奇数长度有 1 字节填充）
      offset = body + size + (size & 1);
    }
    if (!fmt) throw new Error('WAV 缺少 fmt 块');
    if (fmt.format !== 1) throw new Error('仅支持未压缩 PCM（fmt=1）');
    if (fmt.channels !== 1) throw new Error('仅支持单声道音轨');
    if (fmt.bits !== 16) throw new Error('仅支持 16bit PCM');
    if (dataOffset < 0) throw new Error('WAV 缺少 data 块');

    const frameBytes = Math.floor(dataLength / 2) * 2;
    const samples = new Int16Array(frameBytes / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = dv.getInt16(dataOffset + i * 2, true);
    }
    return { sampleRate: fmt.sampleRate, samples: samples };
  }

  /** 编码为 16bit 单声道 PCM WAV（44 字节标准头），返回 ArrayBuffer */
  function encodeWav(samples, sampleRate) {
    const dataBytes = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);
    const writeId = function (off, id) {
      for (let i = 0; i < 4; i++) dv.setUint8(off + i, id.charCodeAt(i));
    };
    writeId(0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    writeId(8, 'WAVE');
    writeId(12, 'fmt ');
    dv.setUint32(16, 16, true);          // fmt 块长度
    dv.setUint16(20, 1, true);           // PCM
    dv.setUint16(22, 1, true);           // 单声道
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true);  // 字节率
    dv.setUint16(32, 2, true);           // 块对齐
    dv.setUint16(34, 16, true);          // 位深
    writeId(36, 'data');
    dv.setUint32(40, dataBytes, true);
    for (let i = 0; i < samples.length; i++) {
      dv.setInt16(44 + i * 2, samples[i], true);
    }
    return buf;
  }

  // ---------- 会话（取消 / 迟到结果防护）----------

  /**
   * 主线程侧会话表：单调递增的 generation。
   * 重新导入或修改参数即开新一代；旧代的迟到结果一律拒绝。
   */
  function createSession() {
    let current = 0;
    return {
      begin: function () { current += 1; return current; },
      current: function () { return current; },
      isCurrent: function (gen) { return gen === current; }
    };
  }

  /**
   * Worker 侧代际闸门：新请求（load/analyze/mix）到来即抬号，
   * 正在运行的旧分析/合成在下一个让出点观察到信号失效，直接退出。
   */
  function createEndpointGuard() {
    let generation = 0;
    return {
      begin: function (gen) {
        if (gen > generation) generation = gen;
        return { gen: generation, signal: { get cancelled() { return gen !== generation; } } };
      },
      get generation() { return generation; }
    };
  }

  return {
    MAX_DELAY: MAX_DELAY,
    WINDOW: WINDOW,
    GAIN_STEP: GAIN_STEP,
    correlationAt: correlationAt,
    isBetter: isBetter,
    findBestDelay: findBestDelay,
    analyze: analyze,
    quantizeGain: quantizeGain,
    mixTracks: mixTracks,
    yieldToEventLoop: yieldToEventLoop,
    parseWav: parseWav,
    encodeWav: encodeWav,
    createSession: createSession,
    createEndpointGuard: createEndpointGuard
  };
});
