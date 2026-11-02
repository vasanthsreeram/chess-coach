import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e', timeout: 180_000,
  use: { baseURL: 'http://localhost:4173' },
  webServer: { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: false },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
