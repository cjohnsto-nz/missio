import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
});
