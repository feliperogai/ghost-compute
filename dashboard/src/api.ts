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
  const token = getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal });
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
