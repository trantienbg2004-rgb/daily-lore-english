import fs from 'node:fs'
import { defineConfig, chromium } from '@playwright/test'

function resolveChromiumLaunchOptions() {
  const defaultPath = chromium.executablePath()
  if (defaultPath && fs.existsSync(defaultPath)) {
    return {}
  }
  const fallbackCandidates = [
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]
  for (const candidate of fallbackCandidates) {
    if (fs.existsSync(candidate)) {
      return { executablePath: candidate }
    }
  }
  return {}
}

const port=Number(process.env.SAGA_QA_PORT||4173)
const baseURL='http://127.0.0.1:'+port
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 2,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: resolveChromiumLaunchOptions(),
      },
    },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port '+port+' --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
