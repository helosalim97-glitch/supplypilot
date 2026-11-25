import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/** httpOnly cookie holding the caller's API bearer token. */
export const TOKEN_COOKIE = 'supplypilot_token';

const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{20,256}=*$/;

export function isTokenShaped(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export async function readToken(): Promise<string | null> {
  const value = (await cookies()).get(TOKEN_COOKIE)?.value;
  return value && isTokenShaped(value) ? value : null;
}

/** The token, or a redirect to sign-in when there is none. */
export async function requireToken(): Promise<string> {
  const token = await readToken();
  if (!token) redirect('/sign-in');
  return token;
}

export async function storeToken(token: string): Promise<void> {
  (await cookies()).set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
}

export async function clearToken(): Promise<void> {
  (await cookies()).delete(TOKEN_COOKIE);
}
