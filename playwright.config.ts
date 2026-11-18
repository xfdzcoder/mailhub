import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:3219', browserName: 'chromium' },
  webServer: { command: 'node tests/browser/server.mjs', url: 'http://127.0.0.1:3219', reuseExistingServer: false },
});
