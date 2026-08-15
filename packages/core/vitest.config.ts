import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**'],
      reporter: ['text', 'html', 'lcov', 'json'],
      thresholds: {
        statements: 87,
        branches: 84,
        functions: 93,
        lines: 87,
      },
    },
    exclude: [
      ...configDefaults.exclude,
      // Local agent worktrees can contain stale test copies and should never
      // affect the repository's test result.
      '**/.claude/**',
      // E2E tests require API keys — run with: npm run test:e2e
      ...(process.env['RUN_E2E'] ? [] : ['tests/e2e/**']),
    ],
  },
})
