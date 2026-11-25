import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="panel">
      <h1>Not found</h1>
      <p>This page doesn&apos;t exist, or your account doesn&apos;t have access to it.</p>
      <p>
        <Link href="/orgs">Back to your organizations</Link>
      </p>
    </section>
  );
}
