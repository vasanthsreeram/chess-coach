import { defineConfig } from 'vite';
import { feedbackApi } from './dev/api';
export default defineConfig({ base: './', build: { target: 'es2020' }, plugins: [feedbackApi()], test: { include: ['tests/**/*.test.ts'] } } as any);
