import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentError, type AgentApi } from './api';
import type { ControlAction, Limits, Status } from './types';

export const POLL_MS = 1000;

export interface AgentView {
  status: Status | null;
  /** Set when the agent cannot be reached; `status` then holds the last known value. */
  error: AgentError | null;
  /** Action in flight (buttons show it and are disabled). */
  pending: ControlAction | null;
  control(a: ControlAction): Promise<void>;
  saveSettings(l: Limits): Promise<Limits>;
}

export function useAgent(api: AgentApi, pollMs = POLL_MS): AgentView {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<AgentError | null>(null);
  const [pending, setPending] = useState<ControlAction | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      if (!alive.current) return;
      setStatus(s);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof AgentError ? e : new AgentError('UNKNOWN', String(e)));
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh, pollMs]);

  const control = useCallback(
    async (a: ControlAction) => {
      setPending(a);
      try {
        const s = await api.control(a);
        if (alive.current) setStatus(s);
      } catch (e) {
        if (alive.current) setError(e instanceof AgentError ? e : new AgentError('UNKNOWN', String(e)));
      } finally {
        if (alive.current) setPending(null);
      }
    },
    [api],
  );

  const saveSettings = useCallback(
    async (l: Limits) => {
      const saved = await api.saveSettings(l);
      await refresh();
      return saved;
    },
    [api, refresh],
  );

  return { status, error, pending, control, saveSettings };
}
