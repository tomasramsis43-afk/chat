export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || 'ERROR');
    this.status = status;
    this.code = code;
  }
}

let authExpiredHandler = null;

export function setAuthExpiredHandler(fn) {
  authExpiredHandler = fn;
}

async function raw(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { res, data };
}

export async function refreshSession() {
  try {
    const { res } = await raw('POST', '/api/auth/refresh');
    return res.ok;
  } catch {
    return false;
  }
}

async function request(method, path, body, opts = {}) {
  let { res, data } = await raw(method, path, body);

  if (res.status === 401 && opts.retry !== false && !path.startsWith('/api/auth/')) {
    const ok = await refreshSession();
    if (ok) {
      ({ res, data } = await raw(method, path, body));
    } else if (authExpiredHandler) {
      authExpiredHandler();
    }
  }

  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code, e.message);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  delete: (path, opts) => request('DELETE', path, undefined, opts)
};