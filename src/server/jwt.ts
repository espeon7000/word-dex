import { jwtVerify, SignJWT } from 'jose';

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return new TextEncoder().encode(secret);
}

// exp is unix seconds, same unit jose's own payload.exp uses - callers doing
// "how close to expiry is this" math (see sync+api.ts's sliding-refresh
// check) can compare it directly against Date.now()/1000 with no conversion.
export type AuthedUser = { userId: number; username: string; exp: number };

export async function issueToken(userId: number, username: string): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<AuthedUser> {
  const { payload } = await jwtVerify(token, getSecret());
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.username !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('invalid token payload');
  }
  return { userId: Number(payload.sub), username: payload.username, exp: payload.exp };
}

// Pulls the bearer token off a request and verifies it - throws a Response
// (per the Expo API Routes convention) so route handlers can just `await` it
// without their own try/catch for the unauthenticated case.
export async function requireAuth(request: Request): Promise<AuthedUser> {
  const header = request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    return await verifyToken(token);
  } catch {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
