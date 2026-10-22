import { WebSocketServer } from 'ws';
import { LoginRateLimiter } from '../auth/rate-limit.js';
import { clientIp } from '../auth/client-ip.js';
import { presentSshServers } from './targets.js';
import { dialSsh } from './ssh.js';
import { runTerminalSession } from './session.js';

const SESSION_PATH = '/api/terminal/session';

function rejectUpgrade(socket, status, error) {
  const reason = {
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
  }[status] || 'Bad Request';
  const body = Buffer.from(JSON.stringify({ error }));
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Content-Type: application/json; charset=utf-8\r\n'
    + `Content-Length: ${body.length}\r\n`
    + 'Connection: close\r\n'
    + 'Cache-Control: private, no-store\r\n\r\n',
  );
  socket.end(body);
}

export function attachTerminalGateway(server, {
  config,
  getSession,
  isAllowedOrigin,
  localServer,
  remoteDashboards,
  dial = dialSsh,
  limits = {},
}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const active = new Set();
  const byToken = new Map();
  const runtimeLimits = {
    idleMs: limits.idleMs ?? config.sshIdleTimeoutMs,
    maxBytes: limits.maxBytes ?? config.sshMaxSessionBytes,
    maxMs: limits.maxMs ?? config.sshMaxSessionMs,
    maxSessions: limits.maxSessions ?? config.sshMaxSessions,
    readyTimeoutMs: limits.readyTimeoutMs ?? config.sshReadyTimeoutMs,
  };
  const upgradeLimiter = new LoginRateLimiter({
    windowMs: limits.upgradeWindowMs ?? 10 * 60 * 1000,
    maxAttempts: limits.upgradeMaxAttempts ?? 30,
  });

  function list() {
    return Promise.resolve(localServer()).then((serverInfo) => presentSshServers(config.sshTargets, {
      localServer: serverInfo,
      remotes: remoteDashboards(),
    }));
  }

  function onUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://internal');
    } catch {
      rejectUpgrade(socket, 400, 'bad request');
      return;
    }
    if (url.pathname !== SESSION_PATH) {
      socket.destroy();
      return;
    }
    if (request.method !== 'GET' || !isAllowedOrigin(request)) {
      rejectUpgrade(socket, 403, 'forbidden');
      return;
    }
    const auth = getSession(request);
    const ip = clientIp(request);
    if (!auth) {
      const anon = upgradeLimiter.check(`anon:${ip}`);
      if (!anon.allowed) {
        rejectUpgrade(socket, 429, '终端连接过于频繁');
        return;
      }
      rejectUpgrade(socket, 401, 'unauthorized');
      return;
    }
    const serverId = url.searchParams.get('server') ?? '';
    const target = (config.sshTargets ?? []).find((item) => item.ready && item.id === serverId);
    if (!target) {
      rejectUpgrade(socket, 404, 'unknown server');
      return;
    }
    const ipRate = upgradeLimiter.check(`ip:${ip}`);
    const sessionRate = upgradeLimiter.check(`session:${auth.token}`);
    if (!ipRate.allowed || !sessionRate.allowed) {
      rejectUpgrade(socket, 429, '终端连接过于频繁');
      return;
    }
    const previous = byToken.get(auth.token);
    if (previous) {
      byToken.delete(auth.token);
      previous.stop('已切换到其他连接');
    }
    if (active.size >= runtimeLimits.maxSessions) {
      rejectUpgrade(socket, 429, '终端会话已满');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const user = String(auth.username || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
      const targetId = String(target.id || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
      console.info(`personal-site terminal: open user=${user} target=${targetId}`);
      const session = runTerminalSession({
        socket: ws,
        target: { ...target, readyTimeoutMs: runtimeLimits.readyTimeoutMs },
        dial,
        limits: runtimeLimits,
        isAlive: () => Boolean(getSession(request)),
        onStop() {
          active.delete(session);
          if (byToken.get(auth.token) === session) byToken.delete(auth.token);
        },
      });
      active.add(session);
      byToken.set(auth.token, session);
    });
  }

  server.on('upgrade', onUpgrade);

  return {
    list,
    close() {
      server.off('upgrade', onUpgrade);
      for (const session of active) session.stop('已断开');
      sockets.close();
    },
  };
}

export { SESSION_PATH };
