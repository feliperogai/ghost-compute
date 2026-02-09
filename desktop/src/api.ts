import type { ControlAction, Limits, Status } from './types';

/** What the UI needs from the agent. */
export interface AgentApi {
  status(): Promise<Status>;
  control(action: ControlAction): Promise<Status>;
  saveSettings(limits: Limits): Promise<Limits>;
}

/** Error surfaced to the owner. `code` comes from the agent (e.g. INVALID_SETTINGS) or AGENT_UNREACHABLE. */
export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toAgentError(e: unknown): AgentError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e)
    return new AgentError(String((e as { code: unknown }).code), String((e as { message: unknown }).message));
  return new AgentError('UNKNOWN', String(e));
}

/** Calls the Tauri backend, which relays to the agent over the local named pipe. */
export function tauriApi(): AgentApi {
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw toAgentError(e);
    }
  };
  return {
    status: () => call<Status>('agent_status'),
    control: (action) => call<Status>('agent_control', { action }),
    saveSettings: (limits) => call<Limits>('agent_save_settings', { limits }),
  };
}

export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
