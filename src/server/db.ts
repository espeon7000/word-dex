import { neon } from '@neondatabase/serverless';

export function getSql() {
  const connectionString = process.env.NEON_CONN_STRING;
  if (!connectionString) throw new Error('NEON_CONN_STRING is not set');
  return neon(connectionString);
}
