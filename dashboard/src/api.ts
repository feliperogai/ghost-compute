// Talks to the control plane with the operator's own API token (kept for this tab only).

const TOKEN_KEY = 'ghost.dashboard.token';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: token lives in memory only */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { signal });
}

/** Writes (two-step verification setup). */
export async function send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function request<T>(path: string, init: { method?: string; body?: string; signal?: AbortSignal | undefined }): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; requestId?: string } } = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, body.error?.code ?? 'HTTP_' + res.status, body.error?.message ?? res.statusText, body.error?.requestId);
  }
  return res.json() as Promise<T>;
}

export type Range = '1h' | '6h' | '24h' | '7d';
