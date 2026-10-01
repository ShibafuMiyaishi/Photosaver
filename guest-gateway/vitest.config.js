// guest-gateway/vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.js'],
    exclude: ['node_modules/**', 'test/helpers/**'],
    testTimeout: 20_000,
  },
});
