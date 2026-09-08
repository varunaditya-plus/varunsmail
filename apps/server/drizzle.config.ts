import { type Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  out: './src/db/migrations-d1',
} satisfies Config;
