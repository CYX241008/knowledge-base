'use client';

import { useEffect, useState, type ReactElement } from 'react';

export function ApiStatus(): ReactElement {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
    fetch(`${baseUrl}/health`)
      .then((response) => setStatus(response.ok ? 'online' : 'offline'))
      .catch(() => setStatus('offline'));
  }, []);
  return (
    <span className={`status status-${status}`}>
      {status === 'checking' ? '正在检查 API' : status === 'online' ? 'API 已连接' : 'API 未连接'}
    </span>
  );
}
