const { defineConfig } = require('vitest/config');
const path = require('node:path');

const TMP_ROOT = path.resolve(__dirname, '..', 'tmp', 'test-output');

module.exports = defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/helpers/setup.js'],
    include: ['test/**/*.test.js'],
    exclude: ['node_modules/**', 'coverage/**', 'test/fixtures/**', 'test/helpers/**'],
    reporters: ['default'],
    outputFile: {
      junit: path.join(TMP_ROOT, 'junit.xml'),
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: path.join(TMP_ROOT, 'coverage'),
      reporter: ['text', 'html'],
      include: ['src/**/*.js'],
    },
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
