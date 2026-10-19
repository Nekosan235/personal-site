import { publicSshError } from './ssh.js';

function socketOpen(socket) {
  return socket.readyState === 1;
}

export function runTerminalSession({ socket, target, dial, limits, isAlive, onStop }) {
  let stopped = false;
  let bridge = null;
  let transferred = 0;
  let idleTimer = null;
  let lifeTimer = null;
  let authTimer = null;
  const pending = [];
  let pendingBytes = 0;
  const size = { cols: 80, rows: 24 };
  const attempt = dial({ ...target, cols: size.cols, rows: size.rows });

  function sendStatus(state, message, code) {
    if (!socketOpen(socket)) return;
    const payload = { type: 'status', state, serverId: target.id };
    if (message) payload.message = message;
    if (code) payload.code = code;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      /* peer already gone */
    }
  }

  function stop(state, message, closeCode = 1000, statusCode = '') {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(lifeTimer);
    clearInterval(authTimer);
    sendStatus(state, message, statusCode);
    try { attempt.cancel?.(); } catch { /* dial already finished */ }
    try { bridge?.close(); } catch { /* shell already closed */ }
    bridge = null;
    try {
      if (socketOpen(socket)) socket.close(closeCode);
    } catch {
      try { socket.terminate?.(); } catch { /* ignore */ }
    }
    onStop?.();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('disconnected', '空闲超时，连接已断开', 4408, 'idle'), limits.idleMs);
  }

  function note(sizeBytes) {
    transferred += sizeBytes;
    if (transferred > limits.maxBytes) {
      stop('disconnected', '会话数据量已达上限', 4408, 'size');
      return false;
    }
    armIdle();
    return true;
  }

  function write(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!note(buffer.length)) return;
    if (bridge) {
      try {
        bridge.write(buffer);
      } catch {
        stop('error', '连接中断', 1011, 'failed');
      }
      return;
    }
    if (pendingBytes + buffer.length > 65_536) return;
    pending.push(buffer);
    pendingBytes += buffer.length;
  }

  sendStatus('connecting', '正在连接');
  armIdle();
  lifeTimer = setTimeout(() => stop('disconnected', '会话时间已达上限', 4408, 'duration'), limits.maxMs);
  authTimer = setInterval(() => {
    if (!isAlive()) stop('error', '登录已失效', 4401, 'auth_expired');
  }, Math.min(5_000, limits.idleMs));

  attempt.done.then((opened) => {
    if (stopped) {
      opened.close();
      return;
    }
    bridge = opened;
    opened.onData((chunk) => {
      if (stopped || !note(chunk.length)) return;
      if (socketOpen(socket)) socket.send(chunk);
    });
    opened.onError((error) => {
      if (stopped) return;
      stop('error', publicSshError(error), 1011, 'failed');
    });
    opened.onClose(() => {
      if (!stopped) stop('disconnected', '已断开', 1000, 'closed');
    });
    try {
      opened.resize(size.cols, size.rows);
    } catch {
      /* the shell may ignore the first resize */
    }
    for (const chunk of pending) {
      if (stopped) return;
      try { opened.write(chunk); } catch { stop('error', '连接中断', 1011, 'failed'); }
    }
    pending.length = 0;
    sendStatus('connected', '已连接');
  }).catch((error) => {
    stop('error', publicSshError(error), 1011, 'failed');
  });

  socket.on('message', (data, isBinary) => {
    if (stopped) return;
    if (!isAlive()) {
      stop('error', '登录已失效', 4401, 'auth_expired');
      return;
    }
    if (isBinary) {
      write(data);
      return;
    }
    let message;
    try {
      message = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'disconnect') {
      stop('disconnected', '已断开', 1000, 'closed');
      return;
    }
    if (message.type === 'input' && typeof message.data === 'string') {
      write(Buffer.from(message.data, 'utf8'));
      return;
    }
    if (message.type === 'resize') {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      size.cols = Math.min(500, Math.max(1, cols));
      size.rows = Math.min(200, Math.max(1, rows));
      try { bridge?.resize(size.cols, size.rows); } catch { /* ignore a raced resize */ }
    }
  });
  socket.on('close', () => stop('disconnected', '已断开', 1000, 'closed'));
  socket.on('error', () => stop('error', '连接中断', 1011, 'failed'));

  return {
    stop(message = '已断开') {
      stop('disconnected', message, 1000, 'closed');
    },
  };
}
