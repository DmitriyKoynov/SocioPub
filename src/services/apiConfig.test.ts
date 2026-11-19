import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('uses the configured application ID in requests to Oracle APEX', async () => {
  vi.stubEnv('VITE_API_MODE', 'real');
  vi.stubEnv('VITE_APEX_APP_ID', '321');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { apiService } = await import('./api');

  await apiService.getAvailableServices('demo-client', 'demo-session');

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toContain('f?p=321:2:demo-session');
});

it('rejects a missing application ID in real mode', async () => {
  vi.stubEnv('VITE_API_MODE', 'real');
  vi.stubEnv('VITE_APEX_APP_ID', '');
  await expect(import('./api')).rejects.toThrow('VITE_APEX_APP_ID');
});
