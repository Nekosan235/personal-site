export const AUTH_EXPIRED_CODE = 'auth_expired';

const SECRET_TEXT = /private key|password|passwd|BEGIN |ssh-rsa|token/i;

export function sanitizeStatus(message) {
  const text = String(message ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!text || SECRET_TEXT.test(text)) return '';
  return text;
}

export const SWITCH_STATUS_HOLD_MS = 1600;

export function switchStatus(fromName, toName) {
  return `断开 ${fromName} → 连接 ${toName}`;
}

export function createTerminalController({ connect, onChange, onData, onAuthExpired }) {
  let activeId = 0;
  let switchWaitId = 0;
  let socket = null;
  let phase = 'idle';
  let server = null;
  let pendingServer = null;
  let pendingStatus = '';
  let statusText = '空闲';
  let errorText = '';
  let closeReason = null;
  let disposed = false;

  function snapshot() {
    return {
      phase,
      serverId: phase === 'idle' ? null : server?.id ?? null,
      serverName: server?.name ?? '',
      statusText,
      errorText,
      disconnectEnabled: phase === 'connecting' || phase === 'connected' || phase === 'disconnecting',
    };
  }

  function emit() {
    onChange?.(snapshot());
  }

  function applyClose(localId) {
    if (switchWaitId === localId) {
      const next = pendingServer;
      const text = pendingStatus;
      switchWaitId = 0;
      pendingServer = null;
      pendingStatus = '';
      socket = null;
      if (next && !disposed) start(next, text);
      return;
    }
    if (localId !== activeId) return;
    socket = null;
    if (phase === 'disconnecting' || phase === 'idle') {
      phase = 'idle';
      server = null;
      statusText = '空闲';
      errorText = '';
      closeReason = null;
      emit();
      return;
    }
    if (closeReason?.phase === 'error') {
      phase = 'error';
      errorText = closeReason.text || '连接失败';
      statusText = errorText;
      emit();
      return;
    }
    phase = 'disconnected';
    errorText = '';
    statusText = closeReason?.text || '已断开';
    emit();
  }

  function start(next, text) {
    const localId = ++activeId;
    server = next;
    phase = 'connecting';
    errorText = '';
    closeReason = null;
    statusText = text || `正在连接 ${next.name}`;
    emit();
    socket = connect(next, {
      onData(chunk) {
        if (localId !== activeId) return;
        onData?.(chunk);
      },
      onControl(message) {
        if (localId !== activeId || !message || typeof message !== 'object') return;
        if (message.code === AUTH_EXPIRED_CODE) onAuthExpired?.();
        if (message.state === 'connected') {
          errorText = '';
          const switching = statusText.includes(' → 连接 ');
          if (!switching) {
            phase = 'connected';
            statusText = `已连接 ${next.name}`;
            emit();
            return;
          }
          const name = next.name;
          const token = localId;
          emit();
          setTimeout(() => {
            if (disposed || token !== activeId || phase !== 'connecting') return;
            phase = 'connected';
            statusText = `已连接 ${name}`;
            emit();
          }, SWITCH_STATUS_HOLD_MS);
          return;
        }
        if (message.state === 'error') {
          const safe = sanitizeStatus(message.message) || '连接失败';
          closeReason = { phase: 'error', text: safe };
          phase = 'error';
          errorText = safe;
          statusText = safe;
          emit();
          return;
        }
        if (message.state === 'disconnected') {
          closeReason = { phase: 'disconnected', text: sanitizeStatus(message.message) || '已断开' };
        }
      },
      onClose() {
        applyClose(localId);
      },
    });
  }

  function closeActive() {
    const current = socket;
    socket = null;
    try { current?.close(); } catch { /* the peer can already be gone */ }
  }

  return {
    snapshot,
    select(next) {
      if (disposed || !next?.id) return;
      if (server?.id === next.id && (phase === 'connecting' || phase === 'connected' || phase === 'disconnecting')) return;
      const busy = socket && (phase === 'connecting' || phase === 'connected');
      if (busy) {
        const previous = server;
        switchWaitId = activeId;
        pendingServer = next;
        pendingStatus = switchStatus(previous?.name || '当前服务器', next.name);
        server = next;
        phase = 'connecting';
        errorText = '';
        closeReason = null;
        statusText = pendingStatus;
        emit();
        closeActive();
        return;
      }
      switchWaitId = 0;
      pendingServer = null;
      start(next);
    },
    disconnect() {
      if (disposed) return;
      pendingServer = null;
      pendingStatus = '';
      if (!socket || phase === 'idle' || phase === 'error' || phase === 'disconnected') {
        switchWaitId = 0;
        activeId += 1;
        socket = null;
        phase = 'idle';
        server = null;
        statusText = '空闲';
        errorText = '';
        closeReason = null;
        emit();
        return;
      }
      phase = 'disconnecting';
      statusText = server ? `正在断开 ${server.name}` : '正在断开';
      errorText = '';
      emit();
      const localId = activeId;
      closeActive();
      if (switchWaitId === localId) switchWaitId = 0;
    },
    input(data) {
      if (!socket || (phase !== 'connected' && phase !== 'connecting')) return;
      socket.send(data);
    },
    resize(cols, rows) {
      if (!socket || (phase !== 'connected' && phase !== 'connecting')) return;
      socket.resize(cols, rows);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingServer = null;
      pendingStatus = '';
      switchWaitId = 0;
      activeId += 1;
      const current = socket;
      socket = null;
      phase = 'idle';
      try { current?.close(); } catch { /* leaving the page */ }
    },
  };
}
