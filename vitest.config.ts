import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/slack/**/*.test.ts', 'tests/console/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/e2e/**', 'node_modules/**', 'web/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/web/slackOidc.ts', 'src/index.ts', 'src/jobs/runOutbox.ts', 'src/jobs/runReminders.ts'],
    },
  },
});
