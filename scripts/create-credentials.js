#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { hashPassword } from '../server/auth/password.js';

export { hashPassword };

async function questionHidden(prompt) {
  output.write(prompt);
  input.setRawMode?.(true);
  let value = '';

  return await new Promise((resolve, reject) => {
    function cleanup() {
      input.setRawMode?.(false);
      input.off('data', onData);
      input.pause();
      output.write('\n');
    }

    function onData(chunk) {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\b' || char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    input.on('data', onData);
    input.resume();
  });
}

async function main() {
  const rl = createInterface({ input, output });
  const username = (await rl.question('AUTH_USERNAME: ')).trim();
  rl.close();

  const password = await questionHidden('Password: ');
  const passwordAgain = await questionHidden('Confirm password: ');
  if (!username) throw new Error('AUTH_USERNAME is required');
  if (!password) throw new Error('Password is required');
  if (password !== passwordAgain) throw new Error('Passwords do not match');

  const passwordHash = await hashPassword(password);
  const secret = randomBytes(32).toString('base64url');

  output.write('\nGenerated environment values:\n');
  output.write(`AUTH_USERNAME=${username}\n`);
  output.write(`AUTH_PASSWORD_HASH=${passwordHash}\n`);
  output.write(`AUTH_SECRET=${secret}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
