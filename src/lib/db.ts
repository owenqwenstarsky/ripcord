import { PrismaClient } from '@prisma/client';
const globalDb = globalThis as unknown as { ripcordDb?: PrismaClient };
export const db = globalDb.ripcordDb ?? new PrismaClient();
globalDb.ripcordDb = db;
