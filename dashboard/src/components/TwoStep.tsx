// Turning on two-step verification (TOTP): the server makes a secret, the authenticator
// app reads it from the QR code (or the typed key), and a code from the app turns it on.
import { useState } from 'react';
import { encode } from 'uqr';
import { ApiError, send } from '../api';

interface Setup {
  secret: string;
  otpauthUrl: string;
}

/** Dark modules on white in both themes: authenticator apps read that reliably. */
function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  let d = '';
  data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
  return (
    <svg className="qr" role="img" aria-label="QR code para o app autenticador" viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

const problem = (err: unknown) => {
  if (err instanceof ApiError) {
    if (err.code === 'MFA_INVALID') return 'Código errado ou já usado. Digite o código que o app mostra agora.';
    if (err.code === 'MFA_LOCKED') return 'Muitos códigos errados. Espere 15 minutos e tente de novo.';
    return err.message;
  }
  return (err as Error).message;
};

export function TwoStepSetup({ required, onDone, onCancel }: { required: boolean; onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card login">
      <h1>Verificação em duas etapas</h1>
      <p className="secondary">
        {required
          ? 'Contas da equipe precisam dela antes de usar o painel. '
          : 'Protege a conta mesmo se o token vazar. '}
        Use um app autenticador no celular (Google Authenticator, Microsoft Authenticator, Authy…).
      </p>
      {!setup ? (
        <button className="btn" disabled={busy} onClick={() => run(async () => setSetup(await send<Setup>('POST', '/v1/me/mfa/totp')))}>
          Começar
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await send('POST', '/v1/me/mfa/totp/confirm', { code: code.trim() });
              onDone();
            });
          }}
        >
          <ol className="steps">
            <li>No app, adicione uma conta lendo este QR code:</li>
          </ol>
          <QrCode text={setup.otpauthUrl} />
          <p className="muted small">
            Sem câmera? Digite a chave: <code className="key">{setup.secret.replace(/(.{4})(?=.)/g, '$1 ')}</code>
          </p>
          <ol className="steps" start={2}>
            <li>
              <label htmlFor="otp">Código de 6 dígitos que o app mostra</label>
            </li>
          </ol>
          <input
            id="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            Ativar
          </button>
        </form>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {onCancel && (
        <p>
          <button className="btn" onClick={onCancel}>
            Agora não
          </button>
        </p>
      )}
    </div>
  );
}
