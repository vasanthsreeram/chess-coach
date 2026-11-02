// Two-browser multiplayer tests against a running `wrangler dev -c wrangler.local.jsonc` (real local Durable Object).
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'e2e-mp', timeout: 150_000, workers: 1, use: { baseURL: process.env.MP_URL ?? 'http://127.0.0.1:8917' } });
