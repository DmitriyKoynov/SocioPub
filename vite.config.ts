import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET;
  const appId = env.VITE_APEX_APP_ID;
  if (target && !/^\d+$/.test(appId || '')) {
    throw new Error('Set VITE_APEX_APP_ID to the numeric Oracle APEX application ID.');
  }
  return {
    plugins: [react()],
    server: {
      proxy: target ? {
        '/api': {
          target,
          changeOrigin: true,
          cookieDomainRewrite: 'localhost',
          configure: (proxy) => {
            proxy.on('proxyReq', (request) => {
              request.setHeader('Origin', new URL(target).origin);
              request.setHeader('Referer', `${target.replace(/\/$/, '')}/api/f?p=${appId}:LOGIN_JQM_SMARTPHONE`);
            });
            proxy.on('proxyRes', (response) => {
              const location = response.headers.location;
              if (location && /^https?:\/\//i.test(location)) {
                const url = new URL(location);
                if (url.origin === new URL(target).origin) {
                  response.headers.location = `${url.pathname.startsWith('/api') ? '' : '/api'}${url.pathname}${url.search}${url.hash}`;
                }
              }
            });
          }
        }
      } : undefined
    }
  };
});
