'use client';

import { useActionState } from 'react';
import { signIn, type SignInState } from './actions';

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { error: null });
  return (
    <form action={action} className="stack">
      <label htmlFor="token">API token</label>
      <input
        id="token"
        name="token"
        type="password"
        autoComplete="off"
        required
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? 'token-error' : undefined}
      />
      {state.error && (
        <p id="token-error" className="field-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
