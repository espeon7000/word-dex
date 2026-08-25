import { getSql } from '@/server/db';
import { issueToken } from '@/server/jwt';
import { hashPassword } from '@/server/password';
import { captureException } from '@/server/sentry';

// Matches the client-side maxLength in components/auth-screen.tsx - kept
// here too since that's just a TextInput prop, trivially bypassable by
// anyone calling this route directly rather than through the app.
const USERNAME_MAX_LENGTH = 20;

export async function POST(request: Request) {
  try {
    const { email, username, password } = await request.json();

    if (
      typeof email !== 'string' ||
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !username.trim() ||
      !password
    ) {
      return Response.json(
        { error: 'email, username, and password are required' },
        { status: 400 },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim();

    if (normalizedUsername.length > USERNAME_MAX_LENGTH) {
      return Response.json(
        { error: `username must be ${USERNAME_MAX_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }

    const sql = getSql();

    const existing = await sql`
      SELECT email, username FROM users
      WHERE email = ${normalizedEmail} OR username = ${normalizedUsername}
    `;
    if (existing.some((row) => row.email === normalizedEmail)) {
      return Response.json({ error: 'email already taken' }, { status: 409 });
    }
    if (existing.some((row) => row.username === normalizedUsername)) {
      return Response.json({ error: 'username already taken' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const [user] = await sql`
      INSERT INTO users (email, username, password)
      VALUES (${normalizedEmail}, ${normalizedUsername}, ${passwordHash})
      RETURNING id, email, username
    `;

    const token = await issueToken(user.id, user.username);
    return Response.json(
      { token, user: { email: user.email, username: user.username } },
      { status: 201 },
    );
  } catch (error) {
    console.error('[auth/signup] error', error);
    await captureException(error, 'auth/signup');
    return Response.json({ error: 'something went wrong' }, { status: 500 });
  }
}
