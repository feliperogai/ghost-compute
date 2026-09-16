import { useEffect, useState } from 'react';
import { api, ApiError, getToken, setToken } from './api';
import { TwoStepSetup } from './components/TwoStep';
import { Errors } from './pages/Errors';
import { Overview } from './pages/Overview';
import { WorkerDetail } from './pages/WorkerDetail';
import { Workers } from './pages/Workers';

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Login({ onDone, onEnroll }: { onDone: () => void; onEnroll: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card login"
      onSubmit={async (e) => {
        e.preventDefault();
        setToken(value.trim());
        try {
          await api('/v1/dashboard/overview');
          onDone();
        } catch (err) {
          // Staff must turn on two-step verification first: keep the token for that.
          if (err instanceof ApiError && err.code === 'MFA_ENROLLMENT_REQUIRED') return onEnroll();
          setToken(null);
          setError(err instanceof ApiError && err.status === 401 ? 'Token inválido.' : err instanceof ApiError && err.status === 403 ? 'Este token não tem acesso ao painel.' : (err as Error).message);
        }
      }}
    >
      <h1>ghost · rede</h1>
      <p className="secondary">Entre com um token de API (papel viewer ou acima). Ele fica só nesta aba.</p>
      <label htmlFor="token">Token</label>
      <input id="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="ghu_…" />
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <button className="btn" type="submit" disabled={!value.trim()}>
        Entrar
      </button>
    </form>
  );
}

/** Two-step verification is off (and optional): offer to turn it on. */
function useMfaOff(active: boolean) {
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    api<{ enabled: boolean }>('/v1/me/mfa', ac.signal)
      .then((m) => setOff(!m.enabled))
      .catch(() => {});
    return () => ac.abort();
  }, [active]);
  return [off, setOff] as const;
}

export function App() {
  const hash = useHash();
  const [stage, setStage] = useState<'login' | 'enroll' | 'optional-enroll' | 'ready'>(getToken() ? 'ready' : 'login');
  const [mfaOff, setMfaOff] = useMfaOff(stage === 'ready');
  if (stage === 'login') return <Login onDone={() => setStage('ready')} onEnroll={() => setStage('enroll')} />;
  if (stage === 'enroll' || stage === 'optional-enroll')
    return (
      <TwoStepSetup
        required={stage === 'enroll'}
        onDone={() => {
          setMfaOff(false);
          setStage('ready');
        }}
        {...(stage === 'optional-enroll' ? { onCancel: () => setStage('ready') } : {})}
      />
    );
  const worker = /^#\/workers\/([0-9a-f-]{36})/.exec(hash)?.[1];
  const page = worker ? 'workers' : hash.startsWith('#/workers') ? 'workers' : hash.startsWith('#/errors') ? 'errors' : 'overview';
  const link = (href: string, label: string, key: string) => (
    <a href={href} aria-current={page === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">ghost</span>
        <nav className="nav">
          {link('#/', 'Visão geral', 'overview')}
          {link('#/workers', 'Workers', 'workers')}
          {link('#/errors', 'Erros', 'errors')}
        </nav>
        <span className="spacer" />
        {mfaOff && (
          <button className="btn" onClick={() => setStage('optional-enroll')}>
            Ativar verificação em duas etapas
          </button>
        )}
        <button
          className="btn"
          onClick={() => {
            setToken(null);
            setStage('login');
          }}
        >
          Sair
        </button>
      </header>
      <main className="main">
        {worker ? <WorkerDetail id={worker} /> : page === 'workers' ? <Workers /> : page === 'errors' ? <Errors /> : <Overview />}
      </main>
    </div>
  );
}
