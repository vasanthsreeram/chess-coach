// Deploy config for the `cf` CLI. Static assets from ./dist; only /api/* runs the Worker first.
import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'chess-vasanth',
    compatibilityDate: '2026-11-02',
    domains: ['chess.vasanth.cloud'],
    entrypoint: '../worker/index.ts',
    assets: { runWorkerFirst: ['/api/*'] },
    env: {
      ASSETS: bindings.assets(),
      AI: bindings.ai(),
      // Approximate per-location limits; reserve separate namespaces.
      RL_IP: bindings.rateLimit({ namespace: '1793608201', simple: { limit: 12, period: 60 } }),
      RL_GLOBAL: bindings.rateLimit({ namespace: '1793608202', simple: { limit: 16, period: 60 } }),
    },
  },
});
