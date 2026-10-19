import { isAbsolute } from 'node:path';

const SSH_SLOTS = 8;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/;
const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,253}$/;

function textValue(overrides, env, lower, upper) {
  const value = overrides[lower] ?? overrides[upper] ?? env[upper];
  return typeof value === 'string' ? value.trim() : '';
}

function clampPort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 22;
  return Math.min(65535, Math.max(1, parsed));
}

function deviceMatch(devices, id) {
  return devices.find((device) => device && device.id === id) ?? null;
}

function hasCredential(input) {
  return Boolean(input.privateKeyFile || input.passwordFile || input.privateKey || input.password);
}

export function normalizeSshTarget(input = {}, devices = [], slot = 0) {
  const id = String(input.id ?? '').trim();
  const device = deviceMatch(devices, id);
  const explicitDial = String(input.dialHost || input.host || '').trim();
  const inheritedHost = String(device?.ip || '').trim();
  const dialHost = explicitDial || inheritedHost;
  const displayHost = String(input.displayHost || inheritedHost || explicitDial).trim();
  const name = String(input.name || device?.name || id).trim().slice(0, 80);
  const region = String(input.region ?? device?.region ?? '').trim().slice(0, 80);
  const username = String(input.username ?? '').trim();
  const privateKeyFile = String(input.privateKeyFile ?? '').trim();
  const passwordFile = String(input.passwordFile ?? '').trim();
  const privateKey = typeof input.privateKey === 'string' ? input.privateKey : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const hostFingerprint = String(input.hostFingerprint ?? '').trim();
  const credential = hasCredential({ privateKeyFile, passwordFile, privateKey, password });
  return {
    slot,
    id,
    name,
    region,
    dialHost,
    displayHost,
    port: clampPort(input.port),
    username,
    privateKeyFile,
    passwordFile,
    privateKey,
    password,
    hostFingerprint,
    ready: Boolean(id && username && dialHost && credential),
  };
}

export function loadSshTargets(overrides, env, devices) {
  if (Array.isArray(overrides.sshTargets)) {
    return overrides.sshTargets.map((target, index) => normalizeSshTarget(target, devices, index + 1));
  }
  const targets = [];
  for (let slot = 1; slot <= SSH_SLOTS; slot += 1) {
    const id = textValue(overrides, env, `ssh${slot}Id`, `SSH_${slot}_ID`);
    if (!id) continue;
    targets.push(normalizeSshTarget({
      id,
      name: textValue(overrides, env, `ssh${slot}Name`, `SSH_${slot}_NAME`),
      region: textValue(overrides, env, `ssh${slot}Region`, `SSH_${slot}_REGION`),
      dialHost: textValue(overrides, env, `ssh${slot}Host`, `SSH_${slot}_HOST`),
      displayHost: textValue(overrides, env, `ssh${slot}DisplayHost`, `SSH_${slot}_DISPLAY_HOST`),
      port: textValue(overrides, env, `ssh${slot}Port`, `SSH_${slot}_PORT`) || 22,
      username: textValue(overrides, env, `ssh${slot}Username`, `SSH_${slot}_USERNAME`),
      privateKeyFile: textValue(overrides, env, `ssh${slot}PrivateKeyFile`, `SSH_${slot}_PRIVATE_KEY_FILE`),
      passwordFile: textValue(overrides, env, `ssh${slot}PasswordFile`, `SSH_${slot}_PASSWORD_FILE`),
      privateKey: textValue(overrides, env, `ssh${slot}PrivateKey`, `SSH_${slot}_PRIVATE_KEY`),
      password: textValue(overrides, env, `ssh${slot}Password`, `SSH_${slot}_PASSWORD`),
      hostFingerprint: textValue(overrides, env, `ssh${slot}HostFingerprint`, `SSH_${slot}_HOST_FINGERPRINT`),
    }, devices, slot));
  }
  return targets;
}

export function validateSshTargets(targets) {
  if (targets == null) return [];
  const missing = [];
  if (!Array.isArray(targets)) return ['SSH targets are invalid'];
  if (targets.length > SSH_SLOTS) missing.push('at most 8 SSH targets');
  const seen = new Set();
  for (const target of targets) {
    const label = target?.id || `slot ${target?.slot || '?'}`;
    if (!target || !ID_PATTERN.test(target.id || '')) {
      missing.push(`SSH target id for ${label} must match [A-Za-z0-9_.:-]{1,64}`);
      continue;
    }
    if (seen.has(target.id)) missing.push(`duplicate SSH target id ${target.id}`);
    seen.add(target.id);
    if (!USER_PATTERN.test(target.username || '')) missing.push(`SSH username for ${target.id} is missing or invalid`);
    if (!target.dialHost || !HOST_PATTERN.test(target.dialHost) || /^[^:]+:\d+$/.test(target.dialHost)) {
      missing.push(`SSH host for ${target.id} is missing or invalid`);
    }
    if (target.privateKeyFile && !isAbsolute(target.privateKeyFile)) {
      missing.push(`SSH private key path for ${target.id} must be absolute`);
    }
    if (target.passwordFile && !isAbsolute(target.passwordFile)) {
      missing.push(`SSH password path for ${target.id} must be absolute`);
    }
    if (target.privateKey && !target.privateKey.includes('PRIVATE KEY')) {
      missing.push(`SSH private key for ${target.id} must be a PEM private key`);
    }
    if (target.hostFingerprint && !/^SHA256:[A-Za-z0-9+/]{20,128}={0,2}$/.test(target.hostFingerprint)) {
      missing.push(`SSH host fingerprint for ${target.id} must look like SHA256:...`);
    }
    if (!target.ready) missing.push(`SSH target ${target.id} is missing credentials or a dial host`);
  }
  return missing;
}

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function mapOnline(status) {
  if (status === 'online') return 'online';
  if (status === 'offline' || status === 'stale' || status === 'error') return 'offline';
  if (status === 'waiting') return 'waiting';
  return 'unknown';
}

function cardFor(target, localServer, remotes) {
  if (localServer && localServer.id === target.id) return localServer;
  const remote = (remotes ?? []).find((item) => item?.id === target.id || item?.server?.id === target.id);
  return remote?.server ?? null;
}

export function presentSshServer(target, { localServer = null, remotes = [] } = {}) {
  const card = cardFor(target, localServer, remotes);
  const remote = (remotes ?? []).find((item) => item?.id === target.id || item?.server?.id === target.id);
  const host = clean(card?.ip) || clean(card?.host) || clean(target.displayHost) || clean(target.dialHost);
  return {
    id: target.id,
    name: clean(card?.name) || clean(remote?.name) || target.name || target.id,
    region: clean(card?.region) || clean(target.region),
    host,
    online: mapOnline(card?.status),
  };
}

export function presentSshServers(targets, context) {
  return (targets ?? []).filter((target) => target?.ready).map((target) => presentSshServer(target, context));
}
