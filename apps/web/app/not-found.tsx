import Link from 'next/link';
import { Wordmark } from '@/components/shell';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[440px]">
        <Wordmark className="text-[22px]" />
        <div className="mt-6 rounded-[12px] border border-rule bg-sheet px-6 pt-6 pb-6">
          <h1 className="serif text-[24px] text-ink">Page not found</h1>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            There is nothing at this address. The link may be mistyped or out of date.
          </p>
          <Link href="/" className="btn btn-primary mt-5">
            Go to your agreements
          </Link>
        </div>
      </div>
    </main>
  );
}
