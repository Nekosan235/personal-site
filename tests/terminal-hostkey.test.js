import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { dialSsh } from '../server/terminal/ssh.js';
import {
  HOSTKEY_UNSET_MESSAGE,
  fingerprintHostKey,
  hostKeyAccepted,
  parseHostFingerprints,
} from '../server/terminal/hostkey.js';

const passwordHash = await hashPassword('test-only-password-2026');
const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const OTHER = 'SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg';

async function configWith(t, env) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-ssh-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return loadConfig(env, {
    NODE_ENV: 'production',
    SITE_ORIGIN: 'https://terminal.example',
    DATA_DIR: directory,
    AUTH_USERNAME: 'terminal-user',
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: 'x'.repeat(40),
  });
}

test('host fingerprints accept ssh-keygen output and reject malformed pins', () => {
  const key = Buffer.from('ssh-ed25519 test key material');
  const actual = fingerprintHostKey(key);
  const parsed = parseHostFingerprints(`256 ${actual}= host.example (ED25519)`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.fingerprints, [actual]);
  assert.equal(hostKeyAccepted(parsed.fingerprints, key), true);
  assert.equal(hostKeyAccepted([`SHA256:${'A'.repeat(43)}`], key), false);

  const many = parseHostFingerprints(`${FINGERPRINT}, ${OTHER}`);
  assert.deepEqual(many.fingerprints, [FINGERPRINT, OTHER]);
  assert.equal(parseHostFingerprints('').ok, true);
  assert.equal(parseHostFingerprints('md5:abc').ok, false);
  assert.equal(parseHostFingerprints('SHA256:!!!').ok, false);
});

test('server and remote cloud env supply host keys, usernames, and key files', async (t) => {
  const config = await configWith(t, {
    SERVER_ID: 'cloud-01',
    SERVER_IP: '203.0.113.10',
    SERVER_SSH_USERNAME: 'ops',
    SERVER_SSH_PRIVATE_KEY_FILE: '/etc/personal-site/ssh/cloud-01.key',
    SERVER_SSH_HOSTKEY: `256 ${FINGERPRINT}= cloud-01 (ED25519)`,
    SSH_1_ID: 'cloud-01',
    SSH_1_HOST: '127.0.0.1',
    REMOTE_CLOUD_2_ID: 'huawei-cn-east-3',
    REMOTE_CLOUD_2_IP: '203.0.113.12',
    REMOTE_CLOUD_2_SSH_USERNAME: 'ops',
    REMOTE_CLOUD_2_SSH_PRIVATE_KEY_FILE: '/etc/personal-site/ssh/remote.key',
    REMOTE_CLOUD_2_SSH_PASSWORD_FILE: '/etc/personal-site/ssh/remote.pass',
    REMOTE_CLOUD_2_SSH_HOSTKEY: `${OTHER},${FINGERPRINT}`,
    SSH_2_ID: 'huawei-cn-east-3',
  });
  const local = config.sshTargets.find((target) => target.id === 'cloud-01');
  const remote = config.sshTargets.find((target) => target.id === 'huawei-cn-east-3');
  assert.equal(local.username, 'ops');
  assert.equal(local.privateKeyFile, '/etc/personal-site/ssh/cloud-01.key');
  assert.equal(local.passwordFile, '');
  assert.equal(local.hostFingerprint, FINGERPRINT);
  assert.equal(local.dialHost, '127.0.0.1');
  assert.equal(local.ready, true);
  assert.equal(remote.username, 'ops');
  assert.equal(remote.privateKeyFile, '/etc/personal-site/ssh/remote.key');
  assert.equal(remote.passwordFile, '/etc/personal-site/ssh/remote.pass');
  assert.equal(remote.hostFingerprint, `${OTHER},${FINGERPRINT}`);
  assert.equal(remote.dialHost, '203.0.113.12');
  assert.equal(remote.trustOnFirstUse, false);
  validateRuntimeConfig(config);
});

test('slot settings override inherited key auth and a password file remains valid alone', async (t) => {
  const overridden = await configWith(t, {
    SERVER_ID: 'cloud-01',
    SERVER_SSH_USERNAME: 'ops',
    SERVER_SSH_PRIVATE_KEY_FILE: '/etc/personal-site/ssh/cloud-01.key',
    SERVER_SSH_HOSTKEY: FINGERPRINT,
    SSH_1_ID: 'cloud-01',
    SSH_1_HOST: '127.0.0.1',
    SSH_1_USERNAME: 'root',
    SSH_1_PASSWORD_FILE: '/etc/personal-site/ssh/cloud-01.pass',
    SSH_1_HOST_FINGERPRINT: OTHER,
    SSH_2_ID: 'password-only',
    SSH_2_HOST: '203.0.113.20',
    SSH_2_USERNAME: 'root',
    SSH_2_PASSWORD_FILE: '/etc/personal-site/ssh/password-only.pass',
  });
  const local = overridden.sshTargets.find((target) => target.id === 'cloud-01');
  const passwordOnly = overridden.sshTargets.find((target) => target.id === 'password-only');
  assert.equal(local.username, 'root');
  assert.equal(local.privateKeyFile, '/etc/personal-site/ssh/cloud-01.key');
  assert.equal(local.passwordFile, '/etc/personal-site/ssh/cloud-01.pass');
  assert.equal(local.hostFingerprint, OTHER);
  assert.equal(passwordOnly.privateKeyFile, '');
  assert.equal(passwordOnly.passwordFile, '/etc/personal-site/ssh/password-only.pass');
  assert.equal(passwordOnly.ready, true);
  validateRuntimeConfig(overridden);

  const invalid = await configWith(t, {
    SSH_1_ID: 'cloud-01',
    SSH_1_HOST: '127.0.0.1',
    SSH_1_USERNAME: 'ops',
    SSH_1_PRIVATE_KEY_FILE: 'relative.key',
    SSH_1_HOST_FINGERPRINT: 'md5:abc',
  });
  assert.throws(() => validateRuntimeConfig(invalid), /private key path|SHA256/);

  const tofu = await configWith(t, {
    SSH_HOSTKEY_TOFU: 'yes',
    SSH_1_ID: 'cloud-01',
    SSH_1_HOST: '127.0.0.1',
    SSH_1_USERNAME: 'ops',
    SSH_1_PASSWORD_FILE: '/etc/personal-site/ssh/cloud-01.pass',
  });
  assert.equal(tofu.sshTargets[0].trustOnFirstUse, true);
  assert.equal(tofu.sshTargets[0].hostFingerprint, '');
});

test('dial refuses an unpinned host before opening a socket', async () => {
  const attempt = dialSsh({
    id: 'cloud-01',
    dialHost: '127.0.0.1',
    port: 1,
    username: 'ops',
    password: 'test-only',
  });
  await assert.rejects(attempt.done, (error) => {
    assert.equal(error.publicMessage, HOSTKEY_UNSET_MESSAGE);
    assert.equal(error.code, 'HOSTKEY_UNSET');
    return true;
  });
});
