/* app.js —— 页面状态、文件导入、Worker 会话与试听/下载共用缓冲 */
(function () {
  'use strict';

  const C = window.PcmCore;

  const fileInput = document.getElementById('fileInput');
  const statusEl = document.getElementById('status');
  const errorBox = document.getElementById('errorBox');
  const trackSection = document.getElementById('trackSection');
  const outputSection = document.getElementById('outputSection');
  const trackRows = document.getElementById('trackRows');
  const player = document.getElementById('player');
  const downloadLink = document.getElementById('downloadLink');
  const mixInfo = document.getElementById('mixInfo');

  /** 单调代际：重新导入或修改参数即换代，迟到结果一律拒绝 */
  const session = C.createSession();

  let tracks = [];                 // [{name, samples, sampleRate}]
  let autoDelays = [];             // 分析得到的延时
  let sampleRate = 0;
  let delayInputs = [];
  let gainInputs = [];
  let autoCells = [];
  let currentObjectUrl = null;
  let mixTimer = 0;

  const worker = new Worker('worker.js');
  worker.onmessage = function (e) {
    const msg = e.data;

    if (msg.type === 'loaded') {
      if (!session.isCurrent(msg.gen)) return; // 迟到：忽略
      statusEl.textContent = '已装载 ' + msg.count + ' 路，正在搜索对齐延时…';
      worker.postMessage({ type: 'analyze', gen: msg.gen });
    }

    if (msg.type === 'analyzed') {
      if (!session.isCurrent(msg.gen)) return; // 迟到结果不能替换当前状态
      autoDelays = msg.delays.slice();
      msg.delays.forEach(function (d, i) {
        if (autoCells[i]) autoCells[i].textContent = String(d);
        // 尚未被用户覆写的延时输入同步为自动结果（占位符）
        if (delayInputs[i] && delayInputs[i].value === '') {
          delayInputs[i].placeholder = String(d);
        }
      });
      statusEl.textContent = '对齐完成，正在合成试听…';
      scheduleMix();
    }

    if (msg.type === 'mixed') {
      if (!session.isCurrent(msg.gen)) return; // 迟到合成不能替换当前试听
      applyMixedWav(msg.wav, msg.length);
    }
  };
  worker.onerror = function (e) {
    showError('Worker 错误：' + e.message);
  };

  // ---------- 文件导入 ----------

  fileInput.addEventListener('change', function () {
    const files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = ''; // 允许再次选择同名文件
    if (files.length < 2 || files.length > 6) {
      showError('请选择 2～6 路 WAV 文件（当前 ' + files.length + ' 个）。');
      return;
    }
    importTracks(files).catch(showError);
  });

  async function importTracks(files) {
    hideError();
    const parsed = [];
    let rate = 0;
    for (const file of files) {
      const buf = await file.arrayBuffer();
      let wav;
      try {
        wav = C.parseWav(buf);
      } catch (err) {
        throw new Error('「' + file.name + '」' + err.message);
      }
      if (rate === 0) rate = wav.sampleRate;
      else if (wav.sampleRate !== rate) {
        throw new Error('采样率不一致：「' + file.name + '」为 ' +
          wav.sampleRate + 'Hz，其余为 ' + rate + 'Hz');
      }
      parsed.push({ name: file.name, samples: wav.samples, sampleRate: rate });
    }

    // 新一批导入：换代取消旧分析/旧合成
    const gen = session.begin();
    tracks = parsed;
    sampleRate = rate;
    autoDelays = tracks.map(function () { return 0; });
    clearTimeout(mixTimer);
    releaseObjectUrl();
    outputSection.hidden = true;
    renderRows();

    const transfer = tracks.map(function (t) { return t.samples.buffer; });
    worker.postMessage({
      type: 'load',
      gen: gen,
      sampleRate: sampleRate,
      tracks: tracks.map(function (t) {
        return { name: t.name, samples: t.samples };
      })
    }, transfer);

    trackSection.hidden = false;
    statusEl.textContent = '正在传输并分析 ' + tracks.length + ' 路音轨…';
  }

  // ---------- 参数表格 ----------

  function renderRows() {
    trackRows.innerHTML = '';
    delayInputs = [];
    gainInputs = [];
    autoCells = [];

    tracks.forEach(function (t, i) {
      const tr = document.createElement('tr');

      const tdIndex = document.createElement('td');
      tdIndex.textContent = String(i + 1) + (i === 0 ? '（基准）' : '');
      tr.appendChild(tdIndex);

      const tdName = document.createElement('td');
      tdName.className = 'filename';
      tdName.textContent = t.name;
      tr.appendChild(tdName);

      const tdCount = document.createElement('td');
      tdCount.textContent = String(t.samples.length);
      tr.appendChild(tdCount);

      const tdDur = document.createElement('td');
      tdDur.textContent = (t.samples.length / t.sampleRate).toFixed(3);
      tr.appendChild(tdDur);

      const tdAuto = document.createElement('td');
      tdAuto.className = 'auto-cell';
      tdAuto.textContent = i === 0 ? '0' : '分析中…';
      autoCells[i] = tdAuto;
      tr.appendChild(tdAuto);

      const tdDelay = document.createElement('td');
      const delayInput = document.createElement('input');
      delayInput.type = 'number';
      delayInput.min = '-32';
      delayInput.max = '32';
      delayInput.step = '1';
      delayInput.placeholder = '自动';
      if (i === 0) {
        delayInput.value = '0';
        delayInput.disabled = true;
      }
      delayInput.addEventListener('input', function () {
        markOverride(delayInput);
        onParamsChanged();
      });
      delayInputs[i] = delayInput;
      tdDelay.appendChild(delayInput);
      tr.appendChild(tdDelay);

      const tdGain = document.createElement('td');
      const gainInput = document.createElement('input');
      gainInput.type = 'number';
      gainInput.min = '0';
      gainInput.max = '8';
      gainInput.step = '0.25';
      gainInput.value = '1';
      gainInput.addEventListener('input', onParamsChanged);
      gainInputs[i] = gainInput;
      tdGain.appendChild(gainInput);
      tr.appendChild(tdGain);

      const tdReset = document.createElement('td');
      const resetBtn = document.createElement('button');
      resetBtn.className = 'reset-btn';
      resetBtn.textContent = '恢复自动';
      if (i === 0) resetBtn.disabled = true;
      resetBtn.addEventListener('click', function () {
        delayInput.value = '';
        delayInput.placeholder = String(autoDelays[i]);
        delayInput.classList.remove('overridden');
        resetBtn.disabled = true;
        onParamsChanged();
      });
      tdReset.appendChild(resetBtn);
      tr.appendChild(tdReset);

      // 有覆写时启用“恢复自动”
      delayInput.addEventListener('input', function () {
        resetBtn.disabled = delayInput.value === '';
      });

      trackRows.appendChild(tr);
    });
  }

  function markOverride(input) {
    if (input.value !== '') input.classList.add('overridden');
    else input.classList.remove('overridden');
  }

  function readParams() {
    const delays = tracks.map(function (t, i) {
      if (i === 0) return 0;
      if (delayInputs[i].value === '') return autoDelays[i];
      const v = parseInt(delayInputs[i].value, 10);
      return Number.isFinite(v) ? v : autoDelays[i];
    });
    const gains = tracks.map(function (t, i) {
      // 四分之一整数倍量化（0.3 → 0.25）
      return C.quantizeGain(parseFloat(gainInputs[i].value));
    });
    return { delays: delays, gains: gains };
  }

  // ---------- 修改参数 → 取消旧任务并重新合成 ----------

  function onParamsChanged() {
    if (tracks.length === 0) return;
    statusEl.textContent = '参数已修改，等待稳定后重新合成…';
    clearTimeout(mixTimer);
    mixTimer = setTimeout(runMix, 150);
  }

  function scheduleMix() {
    clearTimeout(mixTimer);
    mixTimer = setTimeout(runMix, 0);
  }

  function runMix() {
    if (tracks.length === 0) return;
    const gen = session.begin(); // 新一代：旧分析/旧合成立即失效
    const params = readParams();
    worker.postMessage({
      type: 'mix',
      gen: gen,
      delays: params.delays,
      gains: params.gains,
      sampleRate: sampleRate
    });
    statusEl.textContent = '正在合成…';
  }

  // ---------- 试听 / 下载：同一合成缓冲 ----------

  function applyMixedWav(wavBuffer, length) {
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    releaseObjectUrl();
    currentObjectUrl = url;

    // 试听与下载指向同一个 Blob（来自同一个合成 ArrayBuffer）
    player.src = url;
    downloadLink.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadLink.download = 'mix-' + stamp + '.wav';

    mixInfo.textContent = '合成长度：' + length + ' 采样（' +
      (length / sampleRate).toFixed(3) + ' s）';
    outputSection.hidden = false;
    statusEl.textContent = '合成完成，可试听或下载。';
  }

  function releaseObjectUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  }

  function showError(msg) {
    errorBox.textContent = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
})();
