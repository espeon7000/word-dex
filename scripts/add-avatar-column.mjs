// One-off DDL runner - see create-reactions-tables.mjs's own comment for
// why this repo has no migration system. Run once with:
//   node --env-file=.env scripts/add-avatar-column.mjs
// Keep this file after running it - it's the only record of this schema.
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.NEON_CONN_STRING;
if (!connectionString) throw new Error("NEON_CONN_STRING is not set");
const sql = neon(connectionString);

// Stored as a data URI (data:image/jpeg;base64,...) rather than a separate
// object-storage bucket - there's no blob storage wired up anywhere in this
// repo (see AGENTS.md/CLAUDE.md having nothing on it), and profile pictures
// are compressed+downscaled client-side (see profile-picture+api.ts) before
// upload, so they stay small enough for a TEXT column on Neon.
await sql`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT
`;

console.log("users.avatar column ready");
