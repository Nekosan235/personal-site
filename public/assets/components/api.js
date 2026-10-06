export class ApiError extends Error {
  constructor(status) {
    super('Request failed');
    this.name = 'ApiError';
    this.status = status;
  }
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
  if (!response.ok) throw new ApiError(response.status);
  if (response.status === 204) return null;
  return response.json();
}
