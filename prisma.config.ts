// Prisma 7 CLI configuration.
//
// The connection URL lives here (and only here) for CLI work — `db push`,
// `migrate`, `studio`. The application runtime never reads this file; it builds
// its own driver adapter in lib/db.ts. `.env` is loaded explicitly because the
// Prisma CLI runs outside Next.js, which is what normally loads it.

import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
