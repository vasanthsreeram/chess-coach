// Integration tests against a running local `wrangler dev -c wrangler.local.jsonc` (real workerd + Durable Object).
import { defineConfig } from 'vite';
export default defineConfig({ test: { include: ['tests-int/**/*.int.test.ts'], testTimeout: 120_000, fileParallelism: false } } as any);
