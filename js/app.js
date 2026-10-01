// app.js —— 主线程：文件导入、参数覆写、试听与下载。
// 试听与下载共用同一份合成缓冲 currentMix（Int16Array）。

import {
  MIN_TRACKS, MAX_TRACKS, MAX_LAG,
  parseWavPcm16, encodeWavPcm16, quantizeGain,
  createTokenGate,
} from './core.js';

const $ = (id) => document.getElementById(id);

const fileInput = $('fileInput');
const statusEl = $('status');
const metaEl = $('meta');
const playBtn = $('playBtn');
const stopBtn = $('stopBtn');
const downloadBtn = $('downloadBtn');
const tracksCard = $('tracksCard');
const trackRows = $('trackRows');

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// 引擎按 load / op 两个代际作废旧任务，主线程令牌与之对应：
//   loadGate：导入代际；opGate：analyze 与 synthesize 共用（新操作顶掉旧操作）。
// autoMixPending：当前是否在等待“自动分析完成后发起一次合成”；
//   用户若在分析返回前手动改参，则该标志清除，迟到 analyzed 只更新显示不再触发合成。
const loadGate = createTokenGate(0);
const opGate = createTokenGate(0);
let autoMixPending = false;

const state = {
  tracks: [],            // [{ name, samples: Int16Array }]
  sampleRate: 0,
  autoDelays: null,      // 最近一次有效分析结果 Int32Array
  overrides: [],         // 各路是否手动覆写延时（第 0 路恒 false）
  manualDelays: [],      // 覆写的延时值
  gains: [],             // 各路增益
  currentMix: null,      // 试听 / 下载共用的合成缓冲
  mixTimer: 0,
};

let audioCtx = null;
let sourceNode = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.onended = null; sourceNode.stop(); } catch { /* 已停止 */ }
    sourceNode = null;
  }
  stopBtn.disabled = true;
  playBtn.disabled = !state.currentMix;
}

async function shutdownAudio() {
  stopPlayback();
  if (audioCtx) { try { await audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = ''; // 允许再次选择同名文件
  if (files.length < MIN_TRACKS || files.length > MAX_TRACKS) {
    setStatus(`请一次选择 ${MIN_TRACKS}～${MAX_TRACKS} 路 WAV（当前 ${files.length} 路），原有轨道保留。`, 'error');
    return;
  }

  const parsed = [];
  try {
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const { sampleRate, samples } = parseWavPcm16(buf);
      if (parsed.length && sampleRate !== parsed[0].sampleRate) {
        throw new Error(`「${f.name}」采样率 ${sampleRate} Hz 与第一路 ${parsed[0].sampleRate} Hz 不一致`);
      }
      parsed.push({ name: f.name, sampleRate, samples });
    }
  } catch (err) {
    setStatus(`导入失败：${err.message}；原有轨道保留。`, 'error');
    return;
  }

  // —— 有效导入：取消一切旧任务，清空旧试听 ——
  await shutdownAudio();
  loadGate.next();   // 作废旧 load
  opGate.next();     // 作废旧 analyze / synthesize
  autoMixPending = false;
  clearTimeout(state.mixTimer);

  // 注意：稍后采样缓冲会零拷贝转移给 Worker，转移后主线程视图失效，
  // 因此这里把展示所需的长度提前固化到 count。
  const sampleRate = parsed[0].sampleRate;
  state.tracks = parsed.map((p) => ({ name: p.name, samples: p.samples, count: p.samples.length }));
  state.sampleRate = sampleRate;
  state.autoDelays = null;
  state.overrides = parsed.map(() => false);
  state.manualDelays = parsed.map(() => 0);
  state.gains = parsed.map(() => 1);
  state.currentMix = null;
  playBtn.disabled = true;
  stopBtn.disabled = true;
  downloadBtn.disabled = true;

  renderRows();
  tracksCard.hidden = false;
  metaEl.textContent = `${parsed.length} 路 · ${sampleRate} Hz · 单声道 PCM16`;
  setStatus('已导入，正在 Worker 中分析各路整数延时（−32～32，前 4096 采样穷举）…', 'busy');

  // 采样缓冲零拷贝转移给 Worker；此后主线程不再持有该数据
  const transfers = parsed.map((t) => t.samples.buffer);
  const loadToken = loadGate.next();
  worker.postMessage({
    type: 'load',
    token: loadToken,
    sampleRate,
    tracks: parsed.map((t) => ({ samples: t.samples })),
  }, transfers);
  const analyzeToken = opGate.next();
  autoMixPending = true; // 本次分析返回后允许触发一次自动合成
  worker.postMessage({ type: 'analyze', token: analyzeToken });
});

// ---------------------------------------------------------------------------
// Worker 回发
// ---------------------------------------------------------------------------

worker.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'tracksLoaded') {
    if (!loadGate.isCurrent(msg.token)) return;
    return; // 状态以发起侧为准，无需处理
  }

  // 主线程令牌门：迟到结果（已重新导入/改参）绝不能落地
  if (msg.type === 'analyzed') {
    if (!opGate.isCurrent(msg.token)) return;
    state.autoDelays = msg.delays;
    renderRows();
    // 只有“当前仍在等待自动分析”时才触发合成；
    // 用户已手动改参的情况下，迟到分析仅更新自动延时显示。
    if (autoMixPending) {
      autoMixPending = false;
      setStatus('延时分析完成，正在合成试听…', 'busy');
      scheduleMix(0);
    }
    return;
  }

  if (msg.type === 'mixed') {
    if (!opGate.isCurrent(msg.token)) return;
    state.currentMix = msg.samples; // 试听与下载共用此缓冲
    playBtn.disabled = false;
    downloadBtn.disabled = false;
    const sec = (msg.samples.length / state.sampleRate).toFixed(3);
    setStatus(`合成就绪：${msg.samples.length} 采样（${sec} 秒），可试听或下载。`);
    return;
  }

  if (msg.type === 'error') {
    setStatus(`Worker 错误：${msg.message}`, 'error');
  }
};

worker.onerror = (e) => setStatus(`Worker 异常：${e.message}`, 'error');

// ---------------------------------------------------------------------------
// 参数与合成
// ---------------------------------------------------------------------------

function effectiveDelay(i) {
  if (i === 0) return 0;
  if (state.overrides[i]) return state.manualDelays[i] | 0;
  return state.autoDelays ? state.autoDelays[i] | 0 : 0;
}

function buildParams() {
  return state.tracks.map((_, i) => ({ delay: effectiveDelay(i), gain: state.gains[i] }));
}

function scheduleMix(delayMs = 120) {
  clearTimeout(state.mixTimer);
  if (!state.tracks.length) return;
  state.mixTimer = setTimeout(() => {
    // 改参即顶掉旧分析/旧合成（同一 op 代际），并作废“分析后自动合成”；
    // 迟到结果由 opGate 令牌门丢弃，不会替换当前试听。
    const token = opGate.next();
    autoMixPending = false;
    setStatus('正在合成…', 'busy');
    worker.postMessage({ type: 'synthesize', token, params: buildParams() });
  }, delayMs);
}

function renderRows() {
  trackRows.innerHTML = '';
  state.tracks.forEach((t, i) => {
    const tr = document.createElement('tr');

    const tdIdx = document.createElement('td');
    tdIdx.textContent = String(i + 1) + (i === 0 ? '（基准）' : '');
    tr.appendChild(tdIdx);

    const tdName = document.createElement('td');
    tdName.textContent = t.name;
    tr.appendChild(tdName);

    const tdDur = document.createElement('td');
    tdDur.textContent = `${(t.count / state.sampleRate).toFixed(3)} s · ${t.count} 采样`;
    tdDur.className = 'muted';
    tr.appendChild(tdDur);

    const tdDelay = document.createElement('td');
    if (i === 0) {
      tdDelay.innerHTML = '<span class="muted">0（固定）</span>';
    } else {
      const wrap = document.createElement('label');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '8px';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.overrides[i];

      const num = document.createElement('input');
      num.type = 'number';
      num.min = String(-MAX_LAG);
      num.max = String(MAX_LAG);
      num.step = '1';
      num.value = String(effectiveDelay(i));
      num.disabled = !cb.checked;

      const auto = document.createElement('span');
      auto.className = 'auto';
      auto.textContent = state.autoDelays
        ? `自动：${state.autoDelays[i] >= 0 ? '+' : ''}${state.autoDelays[i]}`
        : '自动：—';
      auto.style.display = cb.checked ? 'none' : '';

      cb.addEventListener('change', () => {
        state.overrides[i] = cb.checked;
        if (cb.checked) {
          state.manualDelays[i] = effectiveDelay(i);
          num.value = String(state.manualDelays[i]);
        }
        num.disabled = !cb.checked;
        auto.style.display = cb.checked ? 'none' : '';
        scheduleMix(); // 修改参数 → 取消旧分析/旧合成
      });
      num.addEventListener('change', () => {
        let v = Number(num.value);
        if (!Number.isInteger(v)) v = Math.trunc(v);
        v = Math.max(-MAX_LAG, Math.min(MAX_LAG, v));
        num.value = String(v);
        state.manualDelays[i] = v;
        scheduleMix();
      });

      wrap.append(cb, '覆写', num, auto);
      tdDelay.appendChild(wrap);
    }
    tr.appendChild(tdDelay);

    const tdGain = document.createElement('td');
    const gainWrap = document.createElement('div');
    gainWrap.className = 'gain-wrap';
    const g = document.createElement('input');
    g.type = 'number';
    g.min = '0';
    g.max = '4';
    g.step = '0.25';
    g.value = String(state.gains[i]);
    g.addEventListener('change', () => {
      const q = quantizeGain(g.value);
      g.value = String(q);
      state.gains[i] = q;
      scheduleMix(); // 修改参数 → 取消旧分析/旧合成
    });
    gainWrap.append(g, Object.assign(document.createElement('span'), { textContent: '×' }));
    tdGain.appendChild(gainWrap);
    tr.appendChild(tdGain);

    trackRows.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// 试听与下载（同一份 currentMix）
// ---------------------------------------------------------------------------

playBtn.addEventListener('click', async () => {
  if (!state.currentMix) return;
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const mix = state.currentMix; // 与下载同一缓冲
  const ab = audioCtx.createBuffer(1, mix.length, state.sampleRate);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < mix.length; i++) ch[i] = mix[i] / 32768;

  stopPlayback();
  const src = audioCtx.createBufferSource();
  src.buffer = ab;
  src.connect(audioCtx.destination);
  src.onended = () => { if (sourceNode === src) stopPlayback(); };
  src.start();
  sourceNode = src;
  playBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener('click', stopPlayback);

downloadBtn.addEventListener('click', () => {
  if (!state.currentMix) return;
  const wav = encodeWavPcm16(state.currentMix, state.sampleRate); // 同一合成缓冲
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mix_${state.tracks.length}tracks_${state.sampleRate}hz.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
