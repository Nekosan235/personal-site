import { apiRequest } from '../components/api.js?v=1.7.0';
import { element, pageHeading } from '../components/dom.js?v=1.4.0';
import { createTerminalController } from '../components/terminal-session.js?v=1.10.0';

const ONLINE_LABEL = {
  online: '在线',
  offline: '离线',
  waiting: '等待上报',
  unknown: '未知',
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-terminal-src="${src}"]`);
    if (existing?.dataset.loaded === 'true') {
      resolve();
      return;
    }
    const script = existing ?? document.createElement('script');
    const finish = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    const fail = () => reject(new Error('terminal asset failed'));
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!existing) {
      script.src = src;
      script.dataset.terminalSrc = src;
      document.head.append(script);
    }
  });
}

function ensureStyle() {
  const href = '/assets/vendor/xterm/xterm.css?v=1.10.0';
  if (document.querySelector('link[data-terminal-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.terminalStyle = 'true';
  document.head.append(link);
}

async function loadXterm() {
  ensureStyle();
  await loadScript('/assets/vendor/xterm/xterm.js?v=1.10.0');
  await loadScript('/assets/vendor/xterm/addon-fit.js?v=1.10.0');
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon?.FitAddon;
  if (typeof Terminal !== 'function' || typeof FitAddon !== 'function') throw new Error('missing terminal');
  return { Terminal, FitAddon };
}

export async function renderTerminal({ signal }) {
  const status = element('p', {
    className: 'terminal-status',
    text: '空闲',
    attributes: { role: 'status', 'aria-live': 'polite', 'data-state': 'idle' },
  });
  const disconnect = element('button', {
    className: 'terminal-disconnect btn btn-outline-danger',
    text: '断开连接',
    attributes: { type: 'button', disabled: '' },
  });
  const screen = element('div', {
    className: 'terminal-screen',
    attributes: { role: 'region', 'aria-label': '交互终端' },
  });
  const stage = element('section', { className: 'terminal-stage' }, [
    element('div', { className: 'terminal-toolbar' }, [status, disconnect]),
    screen,
  ]);
  const list = element('ul', { className: 'terminal-server-list', attributes: { 'aria-label': '服务器' } });
  const servers = element('aside', { className: 'terminal-servers' }, [
    element('h2', { className: 'terminal-servers-title', text: '服务器' }),
    list,
    element('p', { className: 'terminal-servers-note', text: '登录凭据只留在服务器上。' }),
  ]);
  const page = element('div', { className: 'terminal-page page-enter' }, [
    pageHeading('终端', '选择一台已登记的服务器。连接和登录都在服务器上完成。'),
    element('div', { className: 'terminal-layout' }, [stage, servers]),
  ]);

  let serversCache = [];
  let term = null;
  let fitAddon = null;
  let observer = null;
  let refreshTimer = null;
  let closed = false;
  let lastPhase = 'idle';
  const encoder = new TextEncoder();

  function renderServers(selectedId) {
    list.replaceChildren();
    if (!serversCache.length) {
      list.append(element('li', { className: 'terminal-empty', text: '还没有配置可连接的服务器。' }));
      return;
    }
    for (const server of serversCache) {
      const selected = server.id === selectedId;
      const button = element('button', {
        className: `terminal-server${selected ? ' is-selected' : ''}`,
        attributes: { type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
      }, [
        element('span', { className: 'terminal-server-name', text: server.name }),
        element('span', {
          className: 'terminal-server-online',
          text: ONLINE_LABEL[server.online] || ONLINE_LABEL.unknown,
          attributes: { 'data-online': server.online || 'unknown' },
        }),
        element('span', { className: 'terminal-server-host', text: server.host || '' }),
        server.region ? element('span', { className: 'terminal-server-region', text: server.region }) : null,
      ]);
      button.addEventListener('click', () => controller.select(server));
      list.append(element('li', {}, [button]));
    }
  }

  function applySnapshot(view) {
    const starting = view.phase === 'connecting' && lastPhase !== 'connecting';
    const stopped = view.phase === 'idle' && lastPhase !== 'idle';
    status.textContent = view.statusText;
    status.dataset.state = view.phase;
    disconnect.disabled = !view.disconnectEnabled;
    renderServers(view.serverId);
    if (term && (starting || stopped)) term.reset();
    if (view.phase === 'connected' && lastPhase !== 'connected') term?.focus();
    lastPhase = view.phase;
  }

  function publishSize() {
    if (!fitAddon || !term) return;
    fitAddon.fit();
    controller.resize(term.cols, term.rows);
  }

  const controller = createTerminalController({
    connect(server, handlers) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/terminal/session?server=${encodeURIComponent(server.id)}`);
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => publishSize());
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          try {
            handlers.onControl(JSON.parse(event.data));
          } catch {
            /* ignore a malformed control frame */
          }
          return;
        }
        handlers.onData(event.data);
      });
      socket.addEventListener('close', () => handlers.onClose());
      socket.addEventListener('error', () => {});
      return {
        send(data) {
          if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
        },
        resize(cols, rows) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        },
        close() {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'disconnect' }));
          socket.close();
        },
      };
    },
    onChange: applySnapshot,
    onData(chunk) {
      term?.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    },
    onAuthExpired() {
      window.location.assign('/login');
    },
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(refreshTimer);
    observer?.disconnect();
    window.removeEventListener('resize', publishSize);
    window.removeEventListener('pagehide', cleanup);
    controller.dispose();
    term?.dispose();
    term = null;
  }

  signal.addEventListener('abort', cleanup, { once: true });
  window.addEventListener('pagehide', cleanup);
  disconnect.addEventListener('click', () => controller.disconnect());
  applySnapshot(controller.snapshot());

  async function refreshServers() {
    if (closed || signal.aborted) return;
    try {
      const payload = await apiRequest('/api/terminal/servers', { signal });
      const rows = Array.isArray(payload?.servers) ? payload.servers : [];
      serversCache = rows
        .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
        .map((item) => ({
          id: item.id,
          name: item.name,
          region: typeof item.region === 'string' ? item.region : '',
          host: typeof item.host === 'string' ? item.host : '',
          online: typeof item.online === 'string' ? item.online : 'unknown',
        }));
      renderServers(controller.snapshot().serverId);
    } catch (error) {
      if (closed || signal.aborted || error?.name === 'AbortError' || error?.status === 401) return;
      if (!serversCache.length) {
        list.replaceChildren(element('li', { className: 'terminal-empty', text: '暂时无法读取服务器列表。' }));
      }
    } finally {
      if (!closed && !signal.aborted) refreshTimer = setTimeout(refreshServers, 15_000);
    }
  }

  try {
    const { Terminal, FitAddon } = await loadXterm();
    if (closed || signal.aborted) return page;
    term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 1000,
      theme: {
        background: '#0B0E11',
        foreground: '#E8EDF4',
        cursor: '#3D8BFF',
        cursorAccent: '#0B0E11',
        selectionBackground: 'rgba(61, 139, 255, 0.35)',
        black: '#0B0E11',
        red: '#F07178',
        green: '#3DDC97',
        yellow: '#F0B429',
        blue: '#3D8BFF',
        magenta: '#C792EA',
        cyan: '#7FD1E8',
        white: '#E8EDF4',
        brightBlack: '#5C6B7A',
        brightRed: '#F07178',
        brightGreen: '#3DDC97',
        brightYellow: '#F0B429',
        brightBlue: '#3D8BFF',
        brightMagenta: '#C792EA',
        brightCyan: '#7FD1E8',
        brightWhite: '#FFFFFF',
      },
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(screen);
    term.onData((data) => controller.input(data));
    observer = new ResizeObserver(() => publishSize());
    observer.observe(screen);
    window.addEventListener('resize', publishSize);
    requestAnimationFrame(() => publishSize());
  } catch {
    if (!closed) {
      status.textContent = '终端组件没有载入';
      status.dataset.state = 'error';
    }
  }

  refreshServers();
  return page;
}
