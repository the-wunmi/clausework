import type { Metadata } from 'next';
import { Geist, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppProvider } from '@/components/app-context';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  style: ['normal', 'italic'],
  axes: ['opsz'],
});

export const metadata: Metadata = {
  title: { default: 'Clausework', template: '%s | Clausework' },
  description: 'Upload any agreement. Get a billing system that runs itself, on PayPal.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${newsreader.variable}`}>
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
