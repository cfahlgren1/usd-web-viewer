import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run in Chrome by test:browser.
    exclude: [...configDefaults.exclude, 'test/browser/**'],
  },
});
