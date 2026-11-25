'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="panel" role="alert">
      <h1>Something went wrong</h1>
      <p>The page could not be loaded. Check that the API is running and try again.</p>
      {error.digest && <p className="muted">Reference: {error.digest}</p>}
      <button type="button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
