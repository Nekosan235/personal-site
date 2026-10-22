import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalController, sanitizeStatus, switchStatus, SWITCH_STATUS_HOLD_MS } from '../public/assets/components/terminal-session.js';

function harness() {
  const events = [];
  const sockets = [];
  const controller = createTerminalController({
    connect(server, handlers) {
      let closed = false;
      const socket = {
        server,
        handlers,
        sent: [],
        send(data) { this.sent.push(data); },
        resize(cols, rows) { events.push(['resize', server.id, cols, rows]); },
        close() {
          if (closed) return;
          closed = true;
          events.push(['close', server.id]);
          handlers.onClose();
        },
      };
      sockets.push(socket);
      events.push(['connect', server.id]);
      return socket;
    },
    onAuthExpired() { events.push(['expired']); },
  });
  return { controller, events, sockets };
}

const alpha = { id: 'a', name: '阿里云' };
const beta = { id: 'b', name: '华为云 · 华东' };

test('terminal stays idle until a server is chosen', () => {
  const { controller, events } = harness();
  assert.equal(controller.snapshot().phase, 'idle');
  assert.equal(controller.snapshot().statusText, '空闲');
  assert.equal(controller.snapshot().disconnectEnabled, false);
  assert.deepEqual(events, []);
});

test('choosing a server connects, and disconnect returns to idle', () => {
  const { controller, events, sockets } = harness();
  controller.select(alpha);
  assert.equal(controller.snapshot().phase, 'connecting');
  assert.equal(controller.snapshot().statusText, '正在连接 阿里云');
  assert.equal(controller.snapshot().disconnectEnabled, true);
  assert.equal(controller.snapshot().serverId, 'a');
  sockets[0].handlers.onControl({ type: 'status', state: 'connected' });
  assert.equal(controller.snapshot().phase, 'connected');
  assert.equal(controller.snapshot().statusText, '已连接 阿里云');
  assert.equal(controller.snapshot().disconnectEnabled, true);
  controller.input('ls\n');
  assert.deepEqual(sockets[0].sent, ['ls\n']);
  controller.disconnect();
  assert.equal(controller.snapshot().phase, 'idle');
  assert.equal(controller.snapshot().statusText, '空闲');
  assert.equal(controller.snapshot().serverId, null);
  assert.equal(controller.snapshot().disconnectEnabled, false);
  assert.deepEqual(events.filter((event) => event[0] === 'close'), [['close', 'a']]);
  controller.select(alpha);
  assert.equal(events.filter((event) => event[0] === 'connect').length, 2);
});

test('switching servers disconnects the current session before opening the next one', () => {
  const pending = [];
  const events = [];
  const controller = createTerminalController({
    connect(server, handlers) {
      events.push(['connect', server.id]);
      return {
        send() {},
        resize() {},
        close() {
          events.push(['close', server.id]);
          pending.push(() => handlers.onClose());
        },
      };
    },
  });
  controller.select(alpha);
  controller.select(beta);
  assert.equal(controller.snapshot().phase, 'connecting');
  assert.equal(controller.snapshot().statusText, switchStatus('阿里云', '华为云 · 华东'));
  assert.equal(controller.snapshot().disconnectEnabled, true);
  assert.deepEqual(events, [['connect', 'a'], ['close', 'a']]);
  pending.shift()();
  assert.deepEqual(events, [['connect', 'a'], ['close', 'a'], ['connect', 'b']]);
  assert.equal(controller.snapshot().statusText, '断开 阿里云 → 连接 华为云 · 华东');
});

test('the switch phrase stays visible briefly after the new shell is ready', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = [];
    let latest = null;
    const controller = createTerminalController({
      connect(_server, handlers) {
        latest = handlers;
        return {
          send() {},
          resize() {},
          close() { pending.push(() => handlers.onClose()); },
        };
      },
    });
    controller.select(alpha);
    controller.select(beta);
    pending.shift()();
    latest.onControl({ type: 'status', state: 'connected' });
    assert.equal(controller.snapshot().phase, 'connecting');
    assert.equal(controller.snapshot().statusText, '断开 阿里云 → 连接 华为云 · 华东');
    assert.equal(controller.snapshot().disconnectEnabled, true);
    mock.timers.tick(SWITCH_STATUS_HOLD_MS);
    assert.equal(controller.snapshot().phase, 'connected');
    assert.equal(controller.snapshot().statusText, '已连接 华为云 · 华东');
  } finally {
    mock.timers.reset();
  }
});

test('disconnect stays available while a close is still in progress', () => {
  let closeHandler = null;
  const controller = createTerminalController({
    connect(_server, handlers) {
      return {
        send() {},
        resize() {},
        close() { closeHandler = () => handlers.onClose(); },
      };
    },
  });
  controller.select(alpha);
  controller.disconnect();
  assert.equal(controller.snapshot().phase, 'disconnecting');
  assert.equal(controller.snapshot().statusText, '正在断开 阿里云');
  assert.equal(controller.snapshot().disconnectEnabled, true);
  closeHandler();
  assert.equal(controller.snapshot().phase, 'idle');
  assert.equal(controller.snapshot().disconnectEnabled, false);
});

test('errors stay short and do not keep credential-shaped text', () => {
  const { controller, sockets } = harness();
  controller.select(alpha);
  sockets[0].handlers.onControl({
    type: 'status',
    state: 'error',
    message: 'BEGIN OPENSSH PRIVATE KEY password=hunter2',
  });
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(controller.snapshot().statusText, '连接失败');
  assert.equal(sanitizeStatus('连接超时'), '连接超时');
  assert.equal(sanitizeStatus('主机指纹不匹配'), '主机指纹不匹配');
  assert.equal(sanitizeStatus('未配置主机指纹，已拒绝连接'), '未配置主机指纹，已拒绝连接');
  sockets[0].handlers.onControl({ type: 'status', state: 'error', code: 'auth_expired', message: '登录已失效' });
});

test('an expired session is reported to the page and dispose closes the socket', () => {
  const { controller, events, sockets } = harness();
  controller.select(alpha);
  sockets[0].handlers.onControl({ type: 'status', state: 'error', code: 'auth_expired', message: '登录已失效' });
  assert.deepEqual(events.at(-1), ['expired']);
  controller.dispose();
  assert.equal(events.filter((event) => event[0] === 'close').length, 1);
});
