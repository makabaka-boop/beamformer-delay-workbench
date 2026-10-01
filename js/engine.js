// engine.js —— 环境无关的分析/合成调度器。
//
// Worker 与测试共用同一份合并式（coalescing）状态机：
//   - 至多一个正在执行的任务（active）和一个待办任务（pending）；
//   - pending 可同时携带一个 load 和一个最新的 op（analyze/synthesize），
//     因而“重新导入 + 分析”连续入队时两者都不会丢；
//   - 更晚到达的同槽任务顶替更早的：新 load 顶替 pending load，
//     新 op 顶替 pending op；
//   - active 在开始前 / 每路之间 / 计算中的检查点判定自己是否已被顶替，
//     若已顶替则中止且绝不回发结果——迟到结果因此不可能替换当前试听。
//
// 判定规则（generation 为入队消息自带的单调令牌）：
//   active.load  过时 ⇔ 存在更新一代的 load；
//   active.op    过时 ⇔ 存在更新一代的 op；
//   独立执行时 op.loadGen 等于自己那一代。
//
// 消息（主线程 → 引擎）：
//   { type: 'load',      token, tracks: [{samples: Int16Array}], sampleRate }
//   { type: 'analyze',   token }
//   { type: 'synthesize',token, params: [{delay, gain}, ...] }
// 回发（引擎 → post）：
//   { type: 'analyzed',   token, delays: Int32Array, scores: Int32Array[] }
//   { type: 'mixed',      token, samples: Int16Array }
//   { type: 'tracksLoaded', token, count, sampleRate }
//   { type: 'error',      token, message }

import {
  WINDOW_SAMPLES,
  findBestDelay,
  createMixer,
  accumulateTrack,
  saturateBuffer,
} from './core.js';

export function createEngine({
  post,
  // 让出执行权的钩子；测试可注入确定性调度器
  yieldFn = () => new Promise((r) => setTimeout(r, 0)),
} = {}) {
  if (typeof post !== 'function') throw new Error('createEngine 需要 post 回调');

  // 最新一代：load 与 op 各自计数；任务用对应代际判断是否过时。
  let loadGen = 0;
  let opGen = 0;
  let active = null; // { load?: {...}, op?: {...} }
  let pending = null;
  let loadedTracks = [];
  let sampleRate = 0;

  function loadStale(job) {
    return !!job.load && job.load.token !== loadGen;
  }
  function opStale(job) {
    if (!job.op) return false;
    // 操作属于某一代 load；更新的 load 或更新的 op 都会使其过时。
    return job.op.token !== opGen || job.op.loadToken !== loadGen;
  }

  function enqueue(msg) {
    if (msg.type === 'load') {
      loadGen = msg.token;
      const load = { token: msg.token, tracks: msg.tracks, sampleRate: msg.sampleRate };
      if (!active) { active = { load }; run(); }
      else if (!pending) { pending = { load }; }
      else pending.load = load; // 新导入顶替待办导入
      return;
    }

    const token = msg.token;
    opGen = token;
    const op = {
      token,
      loadToken: loadGen,
      type: msg.type,
      params: msg.params || null,
    };
    if (!active) { active = { op }; run(); }
    else if (!pending) { pending = { op }; }
    else pending.op = op; // 新参数/新分析顶替待办操作
  }

  async function run() {
    const job = active;
    try {
      // 开始前先让出一次：同一时刻连续入队的多个消息可在此之前合并进 pending。
      await yieldFn();

      // ---- load 阶段 ----
      if (job.load) {
        if (loadStale(job)) return;
        loadedTracks = job.load.tracks.map((t) => t.samples);
        sampleRate = job.load.sampleRate;
        post({ type: 'tracksLoaded', token: job.load.token, count: loadedTracks.length, sampleRate });
      }

      // ---- op 阶段 ----
      const op = job.op;
      if (op) {
        if (loadStale(job) || opStale(job)) return;

        if (op.type === 'analyze') {
          if (!loadedTracks.length) { post({ type: 'error', token: op.token, message: '尚未导入音轨' }); return; }
          const ref = loadedTracks[0];
          const delays = new Int32Array(loadedTracks.length);
          const scores = [];
          for (let i = 0; i < loadedTracks.length; i++) {
            // 每路之间让出并检查取消，保证旧分析能及时停止。
            await yieldFn();
            if (loadStale(job) || opStale(job)) return;

            if (i === 0) { delays[i] = 0; scores[i] = new Int32Array(0); continue; }
            const r = findBestDelay(ref, loadedTracks[i], { windowSize: WINDOW_SAMPLES });
            delays[i] = r.delay;
            scores[i] = r.scores;

            if (loadStale(job) || opStale(job)) return;
          }
          post({ type: 'analyzed', token: op.token, delays, scores });
          return;
        }

        if (op.type === 'synthesize') {
          if (!loadedTracks.length) { post({ type: 'error', token: op.token, message: '尚未导入音轨' }); return; }
          const params = op.params;
          if (!params || params.length !== loadedTracks.length) {
            post({ type: 'error', token: op.token, message: '合成参数与轨道数不一致' });
            return;
          }
          // 快照：合成期间即使有新导入也不影响本次读取。
          const tracks = loadedTracks.map((t, i) => ({
            samples: t,
            delay: params[i].delay | 0,
            gain: +params[i].gain,
          }));
          const mixer = createMixer(tracks);
          for (const t of tracks) {
            await yieldFn();
            if (loadStale(job) || opStale(job)) return;
            const ok = accumulateTrack(mixer, t.samples, t.delay, t.gain, () => loadStale(job) || opStale(job));
            if (!ok) return; // 检查点发现取消，且收尾也不应回发
          }
          if (loadStale(job) || opStale(job)) return;
          const samples = saturateBuffer(mixer.mix);
          post({ type: 'mixed', token: op.token, samples });
          return;
        }

        post({ type: 'error', token: op.token, message: `未知任务类型: ${op.type}` });
      }
    } catch (err) {
      if (!loadStale(job) && !opStale(job)) {
        const token = job.op ? job.op.token : (job.load && job.load.token);
        post({ type: 'error', token, message: String(err && err.message || err) });
      }
    } finally {
      active = pending;
      pending = null;
      if (active) run();
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'load' || msg.type === 'analyze' || msg.type === 'synthesize') {
      enqueue(msg);
    }
  }

  return {
    handleMessage,
    // 测试用观察口
    get loadGen() { return loadGen; },
    get opGen() { return opGen; },
    get activeType() {
      if (!active) return null;
      return (active.load ? active.load.type || 'load' : active.op.type) + (active.load ? '+op' : '');
    },
    get hasActiveLoad() { return !!(active && active.load); },
    get activeOpType() { return active && active.op && active.op.type; },
    get pendingOpType() { return pending && pending.op && pending.op.type; },
    get hasPendingLoad() { return !!(pending && pending.load); },
  };
}
