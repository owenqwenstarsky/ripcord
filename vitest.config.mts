import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: '.env', quiet: true });
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { fileParallelism: false, testTimeout: 30000 },
});
