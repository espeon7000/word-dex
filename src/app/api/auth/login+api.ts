import { getSql } from '@/server/db';
import { issueToken } from '@/server/jwt';
import { verifyPassword } from '@/server/password';

export async function POST(request: Request) {
  try {
    const { emailOrUsername, password } = await request.json();

    if (
      typeof emailOrUsername !== 'string' ||
      typeof password !== 'string' ||
      !emailOrUsername ||
      !password
    ) {
      return Response.json({ error: 'invalid email, username, or password' }, { status: 400 });
    }

    const key = emailOrUsername.trim().toLowerCase();
    const sql = getSql();

    const rows = await sql`
      SELECT id, email, username, password FROM users
      WHERE email = ${key} OR LOWER(username) = ${key}
      LIMIT 1
    `;
    const user = rows[0];

    if (!user || !(await verifyPassword(password, user.password))) {
      return Response.json({ error: 'invalid email, username, or password' }, { status: 401 });
    }

    const token = await issueToken(user.id, user.username);
    return Response.json({ token, user: { email: user.email, username: user.username } });
  } catch (error) {
    console.error('[auth/login] error', error);
    return Response.json({ error: 'something went wrong' }, { status: 500 });
  }
}
