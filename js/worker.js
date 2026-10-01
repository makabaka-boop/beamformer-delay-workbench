// worker.js —— Web Worker：音频数据与分析/合成全部在此完成，不上传任何音频。

import { createEngine } from './engine.js';

function postTransferable(msg) {
  const transfers = [];
  if (msg.samples && msg.samples.buffer instanceof ArrayBuffer) {
    // Int16Array 合成缓冲零拷贝交回主线程（试听与下载共用）
    transfers.push(msg.samples.buffer);
  }
  if (msg.delays && msg.delays.buffer instanceof ArrayBuffer) {
    transfers.push(msg.delays.buffer);
  }
  for (const s of msg.scores || []) {
    if (s.buffer instanceof ArrayBuffer) transfers.push(s.buffer);
  }
  self.postMessage(msg, transfers);
}

const engine = createEngine({ post: postTransferable });

self.onmessage = (e) => engine.handleMessage(e.data);
