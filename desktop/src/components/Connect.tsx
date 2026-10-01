import { useState, type FormEvent } from 'react';
import { AgentError, type AgentApi } from '../api';

/**
 * Shown while this computer is not connected to the platform. Connecting identifies the
 * computer; it does NOT start sharing — that stays off until the owner presses Start.
 */
export function Connect({ api, reason }: { api: AgentApi; reason: string }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.enroll(token.trim());
      setToken('');
      setDone(true);
    } catch (err) {
      setError(err instanceof AgentError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <span className="wordmark">ghost</span>
      </header>
      <main className="connect">
        <h1>Conectar este computador</h1>
        <p className="lead">
          O agente ghost está instalado, mas este computador ainda não está ligado a uma conta. Enquanto não estiver,
          nada é compartilhado.
        </p>
        <p className="muted" data-testid="connect-reason">
          {reason}
        </p>

        {done ? (
          <p role="status" className="ok-note">
            Conectado. Carregando o painel…
          </p>
        ) : (
          <form onSubmit={(e) => void submit(e)} aria-describedby="connect-help">
            <label htmlFor="token">Código de conexão ou token da conta</label>
            <input
              id="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghe_… ou ghu_…"
              required
            />
            <button type="submit" className="btn primary" disabled={busy || token.trim().length === 0}>
              {busy ? 'Conectando…' : 'Conectar'}
            </button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </form>
        )}

        <ul id="connect-help" className="help">
          <li>
            <b>Código de conexão</b> (<code>ghe_…</code>): gere no site do ghost, em “Meus computadores → Adicionar
            computador”. Vale uma vez, por uma hora.
          </li>
          <li>
            <b>Token da conta</b> (<code>ghu_…</code>): usado só agora, para pedir um código para este computador. Não
            fica salvo aqui. Se a conta usa verificação em duas etapas, use um código de conexão.
          </li>
          <li>
            Conectar <b>não liga</b> o compartilhamento. Depois de conectado, nada roda até você clicar em{' '}
            <b>Iniciar compartilhamento</b>.
          </li>
        </ul>
      </main>
    </div>
  );
}
