import { useEffect } from 'react';

// 只在当前页面依赖的数据表发生变化时刷新；旧调用不传 tables 时保持全量兼容。
export default function useSyncRefresh(refresh, tables = []) {
  useEffect(() => {
    const handler = event => {
      const changed = event.detail?.tables;
      if (tables.length && Array.isArray(changed) && !tables.some(table => changed.includes(table))) return;
      refresh();
    };
    window.addEventListener('sync:data', handler);
    return () => window.removeEventListener('sync:data', handler);
  }, [refresh, tables.join('|')]);
}
