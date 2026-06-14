'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TaskTreesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/tasks');
  }, [router]);
  return null;
}
