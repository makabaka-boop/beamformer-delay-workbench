/*
 * worker.js —— 音轨分析与混音 Worker
 *
 * 所有重活都在这里完成：
 *   {type:'load',    gen, tracks:[{samples,sampleRate,name}]}  装载新一批轨道
 *   {type:'analyze', gen}                                      整数延时相关性搜索
 *   {type:'mix',     gen, delays, gains, sampleRate}           逐样本混音 + WAV 编码
 *
 * 取消语义：每个请求携带主线程的代际号 gen；新请求到来立即抬升 Worker
 * 内部代际，旧分析/合成在下一个让出点检测到失配后终止（不回传旧结果）。
 * 主线程还会再做一次 gen 校验，迟到结果不会替换当前试听。
 */
(function (global) {
  'use strict';

  if (typeof module !== 'object' || !module.exports) {
    // 浏览器 Worker 环境
    if (typeof importScripts === 'function') importScripts('core.js');
    var PcmCore = global.PcmCore;
  }

  function createWorkerApi(PcmCore) {
    let tracks = [];
    let sampleRate = 0;
    const guard = PcmCore.createEndpointGuard();

    async function handle(msg) {
      if (msg.type === 'load') {
        const token = guard.begin(msg.gen);
        tracks = (msg.tracks || []).map(function (t) {
          return { name: t.name, samples: t.samples };
        });
        sampleRate = msg.sampleRate || 0;
        return { type: 'loaded', gen: token.gen, count: tracks.length };
      }

      if (msg.type === 'analyze') {
        const token = guard.begin(msg.gen);
        const ref = tracks[0].samples.subarray(0, PcmCore.WINDOW);
        const delays = [0];
        // 每一路分块搜索，块间让出事件循环以响应取消
        for (let i = 1; i < tracks.length; i++) {
          const other = tracks[i].samples.subarray(0, PcmCore.WINDOW);
          let bestD = -PcmCore.MAX_DELAY;
          let bestScore = PcmCore.correlationAt(ref, other, bestD);
          for (let d = -PcmCore.MAX_DELAY + 1; d <= PcmCore.MAX_DELAY; d++) {
            if (token.signal.cancelled) return null;
            const score = PcmCore.correlationAt(ref, other, d);
            if (PcmCore.isBetter(score, d, bestScore, bestD)) {
              bestScore = score;
              bestD = d;
            }
            // 每个延时候选都很小，8 个候选让一次即可兼顾取消响应与开销
            if (((d + PcmCore.MAX_DELAY) & 7) === 7) await PcmCore.yieldToEventLoop();
          }
          delays.push(bestD);
        }
        return { type: 'analyzed', gen: token.gen, delays: delays };
      }

      if (msg.type === 'mix') {
        const token = guard.begin(msg.gen);
        const sampleArrays = tracks.map(function (t) { return t.samples; });
        const mixed = await PcmCore.mixTracks(
          sampleArrays,
          msg.delays.slice(),
          msg.gains.slice(),
          token.signal
        );
        if (mixed === null) return null; // 已被新一代请求取消
        const wav = PcmCore.encodeWav(mixed, msg.sampleRate || sampleRate);
        return {
          type: 'mixed',
          gen: token.gen,
          wav: wav,
          length: mixed.length
        };
      }

      throw new Error('未知消息类型: ' + msg.type);
    }

    return { handle: handle };
  }

  if (typeof module === 'object' && module.exports) {
    // Node 测试环境
    module.exports = { createWorkerApi: createWorkerApi };
  } else {
    // 浏览器 Worker
    const api = createWorkerApi(PcmCore);
    global.onmessage = async function (e) {
      const result = await api.handle(e.data);
      if (result == null) return; // 被取消：不回传
      if (result.type === 'mixed' && result.wav) {
        // 转移所有权，避免拷贝
        global.postMessage(result, [result.wav]);
      } else {
        global.postMessage(result);
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
