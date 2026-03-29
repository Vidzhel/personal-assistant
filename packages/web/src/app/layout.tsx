import type { Metadata } from 'next';
import './globals.css';
import { ResponsiveLayout } from '@/components/layout/ResponsiveLayout';

export const metadata: Metadata = {
  title: 'Raven',
  description: 'Personal Assistant Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="flex h-screen overflow-hidden" suppressHydrationWarning>
        <ResponsiveLayout>{children}</ResponsiveLayout>
      </body>
    </html>
  );
}
