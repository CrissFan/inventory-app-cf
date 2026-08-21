import { useEffect } from 'react';

// 当前页面在其他设备产生云端变更并完成拉取后刷新自身数据。
export default function useSyncRefresh(refresh) {
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('sync:data', handler);
    return () => window.removeEventListener('sync:data', handler);
  }, [refresh]);
}
