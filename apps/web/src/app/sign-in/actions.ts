'use server';

import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { listMemberships } from '@/lib/organizations';
import { clearToken, isTokenShaped, storeToken } from '@/lib/session';

export interface SignInState {
  error: string | null;
}

/** Checks the token against the API before keeping it in an httpOnly cookie. */
export async function signIn(_state: SignInState, form: FormData): Promise<SignInState> {
  const raw = form.get('token');
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!isTokenShaped(token)) {
    return { error: 'Paste the API token you were given (at least 20 characters).' };
  }
  try {
    await listMemberships(token);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      return { error: 'That token is not valid, has expired or was revoked.' };
    }
    if (error instanceof ApiRequestError) return { error: error.message };
    throw error;
  }
  await storeToken(token);
  redirect('/orgs');
}

export async function signOut(): Promise<void> {
  await clearToken();
  redirect('/sign-in');
}
