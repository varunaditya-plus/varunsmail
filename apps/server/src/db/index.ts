import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export const createDb = (binding: D1Database) => ({
  db: drizzle(binding, { schema }),
});

export type DB = ReturnType<typeof createDb>['db'];
