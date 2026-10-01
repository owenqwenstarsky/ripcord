import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'RipCord — A place to connect',
  description: 'Your people. Your space. Self-hosted community chat.',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
