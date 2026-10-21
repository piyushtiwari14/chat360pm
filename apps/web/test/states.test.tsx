import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api';
import { AppRoutes } from '../src/App';
import { SessionProvider } from '../src/lib/session';
import { Dialog, EmptyState, ErrorState, Spinner, ToastProvider } from '../src/components/ui';
import { NotFoundPage } from '../src/pages/NotFound';

const me = {
  user: {
    id: 'u1',
    email: 'u1@chat.io',
    displayName: 'Uma User',
    roles: ['tech'],
    status: 'active',
  },
  permissions: { createProject: false, portfolio: false, admin: false },
  onboarding: { steps: [], complete: true, missingRequired: [] },
  outlookConsent: false,
  environment: 'production',
  devAuth: false,
  notificationsConfigured: true,
  supportContact: '',
  timezone: 'Asia/Kolkata',
  today: '2026-10-19',
  release: 'test',
};

function mockFetch(
  routes: Record<string, { status?: number; body: unknown } | (() => Promise<never>)>,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    const r = key
      ? routes[key]
      : { status: 404, body: { error: { code: 'not_found', message: 'nope' } } };
    if (typeof r === 'function') return r();
    return new Response(JSON.stringify(r!.body), {
      status: r!.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('UI states', () => {
  it('renders the custom 404 with a way back', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute('href', '/');
  });

  it('error state explains recovery and shows the error ID', () => {
    const err = new ApiError(
      502,
      'graph_permission_denied',
      'Microsoft 365 denied this operation.',
      undefined,
      'req-1',
      'ERR-ABCD',
    );
    const retry = vi.fn();
    render(
      <MemoryRouter>
        <ErrorState error={err} onRetry={retry} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An administrator needs to check the app permissions',
    );
    expect(screen.getByText('Error ID: ERR-ABCD')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get help' })).toBeInTheDocument();
  });

  it('empty and loading states are announced', () => {
    render(
      <>
        <EmptyState title="No tasks due today" />
        <Spinner label="Loading tasks…" />
      </>,
    );
    expect(screen.getByRole('heading', { name: 'No tasks due today' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading tasks…');
  });

  it('dialog is labelled and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Confirm" onClose={onClose}>
        <input aria-label="x" />
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('routing and session', () => {
  it('redirects anonymous users to sign-in', async () => {
    mockFetch({
      '/api/me': {
        status: 401,
        body: { error: { code: 'unauthenticated', message: 'Please sign in.' } },
      },
      '/api/auth/config': { body: { devAuth: false, entraConfigured: true } },
    });
    renderAt('/projects');
    expect(
      await screen.findByRole('link', { name: /Sign in with your Chat360 Microsoft account/ }),
    ).toHaveAttribute('href', '/api/auth/login?returnTo=%2Fprojects');
  });

  it('shows the 404 page for unknown routes when signed in', async () => {
    mockFetch({ '/api/me': { body: me }, '/api/directory/users': { body: { users: [] } } });
    renderAt('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows the empty state when there are no tasks due today', async () => {
    mockFetch({
      '/api/me': { body: me },
      '/api/directory/users': { body: { users: [] } },
      '/api/today': { body: { today: '2026-10-19', due: [], upcoming: [], delayReasons: [] } },
    });
    renderAt('/today');
    expect(await screen.findByRole('heading', { name: 'No tasks due today' })).toBeInTheDocument();
  });

  it('shows a network error with retry when the API is unreachable', async () => {
    mockFetch({
      '/api/me': { body: me },
      '/api/directory/users': { body: { users: [] } },
      '/api/projects': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    renderAt('/projects');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('hides admin navigation from non-admins and shows the not-found page on /admin', async () => {
    mockFetch({ '/api/me': { body: me }, '/api/directory/users': { body: { users: [] } } });
    renderAt('/admin');
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('asks to connect Outlook before email features', async () => {
    mockFetch({
      '/api/me': { body: me },
      '/api/directory/users': { body: { users: [] } },
      '/api/projects': { body: { projects: [] } },
    });
    renderAt('/email');
    expect(await screen.findByRole('link', { name: 'Connect Outlook' })).toHaveAttribute(
      'href',
      '/api/auth/consent?returnTo=%2Femail',
    );
  });
});

describe('api client', () => {
  it('sends the CSRF header and an idempotency key on writes', async () => {
    const spy = mockFetch({ '/api/x': { body: { ok: true } } });
    await api('/api/x', { method: 'POST', body: {} });
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('chat360');
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('turns API errors into typed errors with field details', async () => {
    mockFetch({
      '/api/x': {
        status: 422,
        body: {
          error: {
            code: 'validation_failed',
            message: 'Some fields are invalid.',
            details: { fields: { name: 'Required' } },
          },
        },
      },
    });
    await expect(api('/api/x')).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      fields: { name: 'Required' },
    });
  });
});

describe('unconfigured deployment', () => {
  it('tells the user setup is incomplete instead of offering a broken sign-in', async () => {
    mockFetch({
      '/api/me': { status: 503, body: { error: { code: 'service_misconfigured', message: 'x' } } },
      '/api/auth/config': {
        status: 503,
        body: { error: { code: 'service_misconfigured', message: 'x' } },
      },
    });
    render(
      <MemoryRouter initialEntries={['/login']}>
        <SessionProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/not fully set up yet/)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Sign in with your Chat360 Microsoft account/ }),
    ).not.toBeInTheDocument();
  });
});
