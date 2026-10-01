import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
config({ path: '.env', quiet: true });
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30000 } });
