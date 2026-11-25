import { redirect } from 'next/navigation';
import { readToken } from '@/lib/session';

export default async function Home() {
  redirect((await readToken()) ? '/orgs' : '/sign-in');
}
