import type { Metadata } from 'next';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { expired } = await searchParams;
  return (
    <section className="panel narrow">
      <h1>Sign in</h1>
      {expired === '1' && (
        <p className="notice warning" role="status">
          Your session ended. Sign in again to continue.
        </p>
      )}
      <p className="muted">
        Use the API token issued for your account. It is kept in an httpOnly cookie and only sent
        to the SupplyPilot API.
      </p>
      <SignInForm />
    </section>
  );
}
