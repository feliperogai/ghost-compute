import { useEffect, useState } from 'react';
import { AgentError } from '../api';
import type { Limits, ScheduleWindow, Status } from '../types';
import { DAYS, celsius, size } from '../text';
import { NumberField } from './NumberField';

interface Props {
  status: Status;
  onSave(l: Limits): Promise<Limits>;
}

const same = (a: Limits, b: Limits) => JSON.stringify(a) === JSON.stringify(b);

export function Settings({ status, onSave }: Props) {
  const [draft, setDraft] = useState<Limits>(status.limits);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [newApp, setNewApp] = useState('');
  const dirty = !same(draft, status.limits);

  // Follow external changes (agent.toml, another window) while the user is not editing.
  useEffect(() => {
    if (!dirty) setDraft(status.limits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.limits]);

  const set = <K extends keyof Limits>(k: K, v: Limits[K]) => {
    setMessage(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await onSave(draft);
      setDraft(saved);
      setMessage({ text: 'Configurações salvas e aplicadas.', error: false });
    } catch (e) {
      const msg = e instanceof AgentError ? e.message : String(e);
      setMessage({ text: `Não foi possível salvar: ${msg}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  const ramTotal = status.hardware.ramMb;
  const ramStep = 256;
  const ramMax = Math.max(ramStep * 2, Math.floor((ramTotal * 0.9) / ramStep) * ramStep);
  const scheduled = draft.schedule.length > 0;

  const setWindow = (i: number, w: ScheduleWindow) =>
    set('schedule', draft.schedule.map((x, j) => (j === i ? w : x)));
  const addApp = () => {
    const name = newApp.trim();
    if (!name || draft.priority_apps.some((a) => a.toLowerCase() === name.toLowerCase())) return;
    set('priority_apps', [...draft.priority_apps, name]);
    setNewApp('');
  };

  return (
    <div className="settings">
      <section className="panel" aria-labelledby="lim-title">
        <h2 className="panel-title" id="lim-title">Quanto do computador emprestar</h2>

        <div className="field">
          <label htmlFor="cpu">CPU máximo permitido</label>
          <input id="cpu" type="range" min={5} max={100} step={5} value={draft.max_cpu_percent}
            onChange={(e) => set('max_cpu_percent', Number(e.target.value))} />
          <output className="num" htmlFor="cpu">{draft.max_cpu_percent}%</output>
          <p className="help">Parte da CPU inteira que os trabalhos podem usar. O sistema garante esse teto.</p>
        </div>

        <div className="field">
          <label htmlFor="gpu">GPU máximo permitido</label>
          <input id="gpu" type="range" min={0} max={100} step={5} value={draft.max_gpu_percent}
            disabled={status.hardware.gpus.length === 0}
            onChange={(e) => set('max_gpu_percent', Number(e.target.value))} />
          <output className="num" htmlFor="gpu">{draft.max_gpu_percent === 0 ? 'Não usar' : `${draft.max_gpu_percent}%`}</output>
          <p className="help">0% mantém a placa de vídeo só para você.</p>
        </div>

        <div className="field">
          <label htmlFor="ram">RAM máxima</label>
          <input id="ram" type="range" min={512} max={ramMax} step={ramStep} value={Math.min(draft.max_ram_mb, ramMax)}
            onChange={(e) => set('max_ram_mb', Number(e.target.value))} />
          <output className="num" htmlFor="ram">{size(draft.max_ram_mb)}</output>
          <p className="help">De {size(ramTotal)} instalados.</p>
        </div>

        <div className="field">
          <label htmlFor="temp">Temperatura máxima</label>
          <input id="temp" type="range" min={50} max={100} step={1} value={draft.max_temperature_c}
            onChange={(e) => set('max_temperature_c', Number(e.target.value))} />
          <output className="num" htmlFor="temp">{celsius(draft.max_temperature_c)}</output>
          <p className="help">Acima disso tudo para até o computador esfriar.</p>
        </div>
      </section>

      <section className="panel" aria-labelledby="when-title">
        <h2 className="panel-title" id="when-title">Quando compartilhar</h2>

        <div className="field">
          <span className="label">Horário permitido</span>
          <div className="days" role="radiogroup" aria-label="Horário permitido">
            <button type="button" className="day" role="radio" aria-checked={!scheduled} aria-pressed={!scheduled}
              onClick={() => set('schedule', [])}>Sempre</button>
            <button type="button" className="day" role="radio" aria-checked={scheduled} aria-pressed={scheduled}
              onClick={() => !scheduled && set('schedule', [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '22:00', to: '07:00' }])}>
              Só em horários definidos
            </button>
          </div>
          <span />
          {scheduled && (
            <div style={{ gridColumn: '1 / -1' }}>
              {draft.schedule.map((w, i) => (
                <div className="window-row" key={i} data-testid="schedule-window">
                  <div className="days" aria-label="Dias">
                    {DAYS.map((d) => {
                      const on = w.days.length === 0 || w.days.includes(d.key);
                      return (
                        <button type="button" key={d.key} className="day" aria-pressed={on}
                          onClick={() => {
                            const cur = w.days.length === 0 ? DAYS.map((x) => x.key) : w.days;
                            const next = on ? cur.filter((x) => x !== d.key) : [...cur, d.key];
                            setWindow(i, { ...w, days: DAYS.map((x) => x.key).filter((k) => next.includes(k)) });
                          }}>
                          {d.short}
                        </button>
                      );
                    })}
                  </div>
                  <label>das <input className="input" type="time" value={w.from} aria-label="Início"
                    onChange={(e) => setWindow(i, { ...w, from: e.target.value })} /></label>
                  <label>às <input className="input" type="time" value={w.to} aria-label="Fim"
                    onChange={(e) => setWindow(i, { ...w, to: e.target.value })} /></label>
                  <button type="button" className="linkish" onClick={() => set('schedule', draft.schedule.filter((_, j) => j !== i))}>
                    Remover
                  </button>
                </div>
              ))}
              <button type="button" className="linkish"
                onClick={() => set('schedule', [...draft.schedule, { days: ['sat', 'sun'], from: '00:00', to: '23:59' }])}>
                + Adicionar horário
              </button>
              <p className="help" style={{ marginTop: 8 }}>Um horário que passa da meia-noite (ex.: 22:00 às 07:00) vale a partir do dia marcado.</p>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="idle">Executar somente com o PC ocioso</label>
          <span>
            {draft.require_idle_secs > 0 && (
              <label>
                sem uso há{' '}
                <NumberField className="input small num" min={1} max={240} aria-label="Minutos sem uso"
                  value={Math.round(draft.require_idle_secs / 60)}
                  onChange={(m) => set('require_idle_secs', m * 60)} />{' '}
                min
              </label>
            )}
          </span>
          <input id="idle" className="switch" type="checkbox" role="switch" checked={draft.require_idle_secs > 0}
            onChange={(e) => set('require_idle_secs', e.target.checked ? 300 : 0)} />
          <p className="help">Nenhuma tecla ou movimento do mouse nesse período.</p>
        </div>

        <div className="field">
          <label htmlFor="locked">Executar somente com o PC bloqueado</label>
          <span />
          <input id="locked" className="switch" type="checkbox" role="switch" checked={draft.only_when_locked}
            onChange={(e) => set('only_when_locked', e.target.checked)} />
          <p className="help">Só depois de você bloquear a sessão (Windows + L).</p>
        </div>

        <div className="field">
          <label htmlFor="battery">Pausar na bateria</label>
          <span />
          <input id="battery" className="switch" type="checkbox" role="switch" checked={draft.pause_on_battery}
            onChange={(e) => set('pause_on_battery', e.target.checked)} />
        </div>
      </section>

      <section className="panel" aria-labelledby="pause-title">
        <h2 className="panel-title" id="pause-title">Pausar automaticamente</h2>
        <div className="field">
          <label htmlFor="games">Durante jogos</label>
          <span />
          <input id="games" className="switch" type="checkbox" role="switch" checked={draft.pause_during_games}
            onChange={(e) => set('pause_during_games', e.target.checked)} />
          <p className="help">Quando um jogo, vídeo ou apresentação estiver em tela cheia.</p>
        </div>
        <div className="field">
          <label htmlFor="newapp">Com aplicativos prioritários abertos</label>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); addApp(); }}>
            <input id="newapp" className="input" placeholder="ex.: obs64.exe" value={newApp} maxLength={100}
              onChange={(e) => setNewApp(e.target.value)} />
            <button className="btn" type="submit" disabled={!newApp.trim()}>Adicionar</button>
          </form>
          <span />
          <div className="chips" style={{ gridColumn: '1 / -1' }} aria-label="Aplicativos prioritários">
            {draft.priority_apps.length === 0 && <span className="help">Nenhum. Adicione editores de vídeo, OBS, ferramentas de trabalho…</span>}
            {draft.priority_apps.map((a) => (
              <span className="chip" key={a}>
                {a}
                <button type="button" aria-label={`Remover ${a}`}
                  onClick={() => set('priority_apps', draft.priority_apps.filter((x) => x !== a))}>×</button>
              </span>
            ))}
          </div>
        </div>
      </section>

      <details className="panel">
        <summary>Avançado</summary>
        <div className="field">
          <label htmlFor="ucpu">Ceder quando você usar mais de</label>
          <input id="ucpu" type="range" min={5} max={100} step={5} value={draft.user_cpu_threshold_percent}
            onChange={(e) => set('user_cpu_threshold_percent', Number(e.target.value))} />
          <output className="num" htmlFor="ucpu">{draft.user_cpu_threshold_percent}% CPU</output>
        </div>
        <div className="field">
          <label htmlFor="uram">Ceder com memória acima de</label>
          <input id="uram" type="range" min={30} max={100} step={5} value={draft.user_ram_threshold_percent}
            onChange={(e) => set('user_ram_threshold_percent', Number(e.target.value))} />
          <output className="num" htmlFor="uram">{draft.user_ram_threshold_percent}%</output>
        </div>
        <div className="field">
          <label htmlFor="resume">Esperar antes de voltar</label>
          <input id="resume" type="range" min={0} max={600} step={15} value={draft.resume_after_secs}
            onChange={(e) => set('resume_after_secs', Number(e.target.value))} />
          <output className="num" htmlFor="resume">{draft.resume_after_secs} s</output>
          <p className="help">Depois que tudo volta ao normal, aguarda este tempo antes de aceitar trabalho de novo.</p>
        </div>
      </details>

      {(dirty || message) && (
        <div className="savebar" role="status">
          <span className={`msg${message?.error ? ' err' : ''}`}>{message?.text ?? 'Alterações não salvas.'}</span>
          <span className="spacer" />
          {dirty && (
            <>
              <button className="btn" onClick={() => { setDraft(status.limits); setMessage(null); }} disabled={saving}>Descartar</button>
              <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
