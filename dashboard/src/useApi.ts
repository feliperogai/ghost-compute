import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetches `path`, refreshes every `everyMs`, keeps the previous data while reloading. */
export function useApi<T>(path: string | null, everyMs = 15_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    try {
      const d = await api<T>(path, c.signal);
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e as Error);
    } finally {
      if (ctl.current === c) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
    if (!everyMs) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), everyMs);
    return () => {
      clearInterval(t);
      ctl.current?.abort();
    };
  }, [load, everyMs]);

  return { data, error, loading, updatedAt, reload: load };
}
