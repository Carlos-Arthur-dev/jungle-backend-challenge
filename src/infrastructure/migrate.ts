import { connectDatabase } from './database';
const orm = await connectDatabase();
try {
  if (process.argv[2] === 'down') await orm.migrator.down();
  else await orm.migrator.up();
} finally { await orm.close(); }
