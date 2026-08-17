// One-off DDL runner - there's no migration system in this repo (the rest
// of the Postgres schema was hand-created against Neon the same way, see
// AGENTS.md/CLAUDE.md having nothing on it). Run once with:
//   node --env-file=.env scripts/create-reactions-tables.mjs
// Keep this file after running it - it's the only record of this schema.
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.NEON_CONN_STRING;
if (!connectionString) throw new Error("NEON_CONN_STRING is not set");
const sql = neon(connectionString);

// users.id is BIGINT (see follow+api.ts's own comment on Neon returning it
// as a string, not a JS number) - reactor_id/user_id below match that.
await sql`
  CREATE TABLE IF NOT EXISTS reactions (
    id BIGSERIAL PRIMARY KEY,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reactor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
await sql`
  CREATE INDEX IF NOT EXISTS reactions_target_idx
    ON reactions (target_kind, target_id, created_at DESC)
`;
await sql`
  CREATE TABLE IF NOT EXISTS push_tokens (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, token)
  )
`;

console.log("reactions + push_tokens tables ready");
