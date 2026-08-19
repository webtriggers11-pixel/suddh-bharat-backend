import { execSync } from 'node:child_process';

// Isolate e2e in its own Postgres schema so tests never touch dev data.
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://shuddha:shuddha@localhost:5436/shuddha?schema=e2e';

process.env.DATABASE_URL = E2E_DATABASE_URL;
process.env.NODE_ENV = 'test';

// Apply migrations to the e2e schema (idempotent).
execSync('npx prisma migrate deploy', {
  env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  stdio: 'ignore',
});
