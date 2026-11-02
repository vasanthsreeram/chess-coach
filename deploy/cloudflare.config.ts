import { bindings, defineConfig, exports as workerExports } from 'cf/config';
export default defineConfig({
  worker: {
    name: 'chess-vasanth', compatibilityDate: '2026-11-02', domains: ['chess.vasanth.cloud'],
    entrypoint: '../worker/entry.ts', assets: { runWorkerFirst: ['/api/*'] },
    exports: { ChessRoom: workerExports.durableObject({ storage: 'sqlite' }) },
    env: {
      ASSETS: bindings.assets(), AI: bindings.ai(),
      ROOMS: bindings.durableObject({ worker: 'chess-vasanth', exportName: 'ChessRoom' }),
      RL_IP: bindings.rateLimit({ namespace: '1793608201', simple: { limit: 12, period: 60 } }),
      RL_GLOBAL: bindings.rateLimit({ namespace: '1793608202', simple: { limit: 16, period: 60 } }),
      RL_ROOM: bindings.rateLimit({ namespace: '1793608203', simple: { limit: 10, period: 60 } }),
      RL_WS: bindings.rateLimit({ namespace: '1793608204', simple: { limit: 60, period: 60 } }),
    },
  },
});
