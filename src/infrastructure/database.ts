import { EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration202611080001 } from './migrations/Migration202611080001';
import { Migration202611080002 } from './migrations/Migration202611080002';
import { Migration202611080003 } from './migrations/Migration202611080003';
import { Migration202611080004 } from './migrations/Migration202611080004';

export interface WalletRow {
  id: string; playerId: string; currency: string; balance: string; version: number;
  createdAt: Date; updatedAt: Date;
}
export const walletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRecord', tableName: 'wallets', properties: {
    id: { type: 'uuid', primary: true }, playerId: { type: 'uuid' }, currency: { type: 'string', length: 3 },
    balance: { type: 'string', columnType: 'numeric(20,2)' }, version: { type: 'integer' },
    createdAt: { type: 'Date' }, updatedAt: { type: 'Date' },
  },
});
export function connectDatabase() {
  return MikroORM.init({
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://jungle:jungle_local@localhost:5432/jungle',
    entities: [walletSchema], extensions: [Migrator],
    migrations: { migrationsList: [Migration202611080001, Migration202611080002, Migration202611080003, Migration202611080004] },
    pool: { min: 0, max: 15 },
  });
}
