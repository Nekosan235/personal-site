import { createThemeController } from './components/theme.js?v=1.2.0';
import { createAppearanceSettings } from './components/appearance.js?v=1.2.0';
import { createAmbientBackground } from './components/ambient.js?v=1.2.0';

const theme = createThemeController();
const appearance = createAppearanceSettings(theme);
document.body.append(appearance.element);
document.querySelector('#login-appearance').addEventListener('click', appearance.open);
createAmbientBackground();

const form = document.querySelector('#login-form');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const submitButton = document.querySelector('#login-submit');
const errorMessage = document.querySelector('#login-error');
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
let submitting = false;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !form.reportValidity()) return;

  submitting = true;
  errorMessage.hidden = true;
  errorMessage.textContent = '';
  submitButton.disabled = true;
  submitButton.textContent = '正在登录…';
  form.setAttribute('aria-busy', 'true');

  try {
    if (!csrfToken || csrfToken === '{{CSRF_TOKEN}}') throw new Error('Missing CSRF token');
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    if (!response.ok) throw new Error('Login failed');
    window.location.assign('/');
  } catch {
    errorMessage.textContent = '登录未成功，请检查账号和密码后重试。';
    errorMessage.hidden = false;
    password.focus();
  } finally {
    submitting = false;
    submitButton.disabled = false;
    submitButton.textContent = '登录';
    form.removeAttribute('aria-busy');
  }
});
