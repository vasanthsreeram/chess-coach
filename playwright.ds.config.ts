// Manual check against real DeepSeek V4.1 Flash: start `DS_REAL=1 npx vite preview --port 4180` first.
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: 'e2e', testMatch: /\.manual\.ts$/, workers: 1, projects: [{ name: 'mobile', use: { ...devices['Pixel 7'] } }] });
