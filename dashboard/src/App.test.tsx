import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { LineChart, niceScale } from './components/LineChart';
import { duration, mb } from './format';
import overview from './fixtures/overview.json';
import history from './fixtures/history.json';
import workers from './fixtures/workers.json';

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

function mockApi(routes: Record<string, unknown>) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    calls.push({ url, auth });
    if (!auth) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    return key ? json(200, routes[key]) : json(404, { error: { code: 'NOT_FOUND', message: 'nope', requestId: 'req-9' } });
  });
  return calls;
}

beforeEach(() => {
  sessionStorage.clear();
  location.hash = '#/';
  vi.stubGlobal('WebSocket', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('scales and formatting', () => {
  it('ticks are round numbers', () => {
    expect(niceScale(2.1, 4, true)).toEqual({ max: 3, step: 1 });
    expect(niceScale(5, 4, true)).toEqual({ max: 6, step: 2 });
    expect(niceScale(100)).toEqual({ max: 100, step: 25 });
    expect(niceScale(0)).toMatchObject({ step: expect.any(Number) });
    expect(niceScale(173).step).toBe(50);
  });
  it('formats sizes and durations', () => {
    expect(mb(512)).toBe('512 MB');
    expect(mb(36864)).toBe('36 GB');
    expect(duration(90061)).toBe('1 d 1 h');
    expect(duration(null)).toBe('—');
  });
});

describe('LineChart', () => {
  const pts = [
    { t: '2026-01-01T10:00:00Z', a: 1, b: 2 },
    { t: '2026-01-01T10:01:00Z', a: null, b: 3 },
    { t: '2026-01-01T10:02:00Z', a: 4, b: 1 },
  ];
  const props = { from: Date.parse('2026-01-01T10:00:00Z'), to: Date.parse('2026-01-01T10:02:00Z'), format: (v: number) => String(v) };

  it('legend for ≥2 series, none for one; every value in the table view', () => {
    const { container, rerender } = render(<LineChart title="T" series={[{ key: 'a', label: 'A', slot: 1 }, { key: 'b', label: 'B', slot: 2 }]} points={pts} {...props} />);
    expect(container.querySelector('.legend')).toHaveTextContent('AB');
    // A gap (null) breaks the line instead of drawing zero.
    const d = container.querySelectorAll('path')[0]!.getAttribute('d')!;
    expect(d.match(/M/g)).toHaveLength(2);
    const table = container.querySelector('details table')!;
    expect(within(table as HTMLElement).getAllByRole('row')).toHaveLength(4);
    expect(table).toHaveTextContent('—');
    rerender(<LineChart title="T" series={[{ key: 'a', label: 'A', slot: 1 }]} points={pts} {...props} />);
    expect(container.querySelector('.legend')).toBeNull();
  });

  it('keyboard moves the crosshair and shows every series', () => {
    const { container } = render(<LineChart title="T" series={[{ key: 'a', label: 'A', slot: 1 }, { key: 'b', label: 'B', slot: 2 }]} points={pts} {...props} />);
    const chart = container.querySelector('.chart')!;
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    const tip = container.querySelector('.tooltip')!;
    expect(tip).toHaveTextContent('1');
    expect(tip).toHaveTextContent('A');
    expect(tip).toHaveTextContent('B');
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(container.querySelector('.tooltip')).toBeNull();
  });

  it('says when there is no data', () => {
    render(<LineChart title="T" series={[{ key: 'a', label: 'A', slot: 1 }]} points={[]} {...props} />);
    expect(screen.getByText('Sem dados neste período')).toBeInTheDocument();
  });
});

describe('App', () => {
  it('asks for a token, rejects a bad one, then shows the network', async () => {
    const calls = mockApi({ '/v1/dashboard/overview': overview, '/v1/dashboard/history': history });
    render(<App />);
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'wrong' } });
    vi.stubGlobal('fetch', () => json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }));
    fireEvent.click(screen.getByText('Entrar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Token inválido.');

    mockApi({ '/v1/dashboard/overview': overview, '/v1/dashboard/history': history });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghu_good' } });
    fireEvent.click(screen.getByText('Entrar'));
    expect(await screen.findByText('Workers online')).toBeInTheDocument();
    expect(screen.getByText('Workers offline')).toBeInTheDocument();
    for (const t of ['CPU total', 'GPU total', 'RAM total', 'VRAM total', 'Na fila', 'Executando', 'Concluídos', 'Falharam', 'Latência da API (p50)', 'Throughput'])
      expect(screen.getByText(t)).toBeInTheDocument();
    expect(await screen.findByText('Latência da API')).toBeInTheDocument();
    expect(screen.getByText(/sandbox crashed/)).toBeInTheDocument();
    expect(sessionStorage.getItem('ghost.dashboard.token')).toBe('ghu_good');
    void calls;
  });

  it('lists workers with hardware, temperature and links to the details page', async () => {
    sessionStorage.setItem('ghost.dashboard.token', 't');
    location.hash = '#/workers';
    mockApi({ '/v1/dashboard/workers': workers });
    render(<App />);
    const row = (await screen.findByText('escritorio-01')).closest('tr')!;
    expect(row).toHaveTextContent('AMD Ryzen 7 5800X');
    expect(row).toHaveTextContent('RTX 4070');
    expect(row).toHaveTextContent('°C');
    fireEvent.change(screen.getByLabelText('Filtrar por estado'), { target: { value: 'offline' } });
    expect(screen.queryByText('escritorio-01')).toBeNull();
    expect(screen.getByText('recepcao')).toBeInTheDocument();
  });

  it('shows API errors with the request id', async () => {
    sessionStorage.setItem('ghost.dashboard.token', 't');
    location.hash = '#/errors';
    mockApi({});
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('request req-9'));
  });
});
