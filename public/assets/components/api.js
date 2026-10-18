export class ApiError extends Error {
  constructor(status, message = 'Request failed') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
  } catch {
    // Keep the generic message when the body is not JSON.
  }
  return 'Request failed';
}

export async function apiRequest(path, { method = 'GET', body, csrfToken, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new ApiError(401);
  }
  if (!response.ok) throw new ApiError(response.status, await readErrorMessage(response));
  if (response.status === 204) return null;
  return response.json();
}
