import { useEffect, useState, useCallback } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Factory, History, Filter, Search, X } from 'lucide-react';
import { getActivityRecords } from '../api/client';
import useSyncRefresh from '../lib/useSyncRefresh';

export default function Movements() {
  const [movements, setMovements] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState(''); // '', 'in', 'out', 'factory'
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pageSize = 50;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, pageSize };
      if (filter) params.type = filter;
      if (debouncedSearch) params.search = debouncedSearch;
      const res = await getActivityRecords(params);
      setMovements(Array.isArray(res?.data?.data) ? res.data.data : []);
      setTotal(res?.data?.total ?? 0);
    } catch (err) {
      console.error('Failed to load movements:', err);
      setMovements([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, filter, debouncedSearch]);

  useEffect(() => { loadData(); }, [loadData]);
  useSyncRefresh(loadData, ['stock_movements', 'product_changes']);
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setDebouncedSearch(search.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.ceil(total / pageSize) || 1;

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const filters = [
    { value: '', label: '全部' },
    { value: 'in', label: '入库' },
    { value: 'out', label: '出库' },
    { value: 'factory', label: '工厂库存变更' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">变更记录</h1>
        <p className="text-sm text-gray-500 mt-0.5">共 {total} 条记录</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          className="input pl-9 pr-10"
          placeholder="搜索商品名称、尺码或条形码"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        {search && <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="清除搜索"><X className="h-4 w-4" /></button>}
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter className="h-4 w-4 shrink-0 text-gray-400" />
        {filters.map(f => (
          <button
            key={f.value}
            onClick={() => { setPage(1); setFilter(f.value); }}
            className={`shrink-0 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === f.value
                ? 'bg-primary-600 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Movements List */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : movements.length === 0 ? (
        <div className="card p-12 text-center text-gray-400 text-sm">
          <History className="w-10 h-10 mx-auto mb-2 text-gray-300" />
          {debouncedSearch ? '未找到相关变更记录' : filter === 'factory' ? '暂无工厂库存变更记录' : '暂无变更记录'}
        </div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="divide-y divide-gray-50">
              {movements.map(m => {
                if (m.record_kind === 'factory') {
                  const factoryLabel = m.field === '待出货库存录入'
                    ? '录入待出货库存'
                    : m.field === '待出货库存调整'
                      ? '调整待出货库存'
                      : '待出货入库销售';
                  return (
                    <div key={`factory_${m.id}`} className="flex items-start gap-3 p-3.5 hover:bg-gray-50">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50"><Factory className="h-5 w-5 text-amber-600" /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><p className="truncate text-sm font-medium text-gray-900">{m.product_name || '已删除商品'}</p><span className="badge shrink-0 bg-amber-50 text-amber-700">{factoryLabel}</span>{m.product_image && <img src={m.product_image} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />}</div>
                        <div className="mt-0.5 flex items-center gap-2"><span className="text-xs text-gray-400">{formatDate(m.created_at)}</span>{m.user_name && <span className="text-xs text-gray-400">· {m.user_name}</span>}</div>
                        <p className="mt-1 text-xs leading-relaxed text-gray-500"><span className="text-gray-400">{m.old_value || '无库存'}</span><span className="mx-1 text-gray-300">→</span><span>{m.new_value || '无库存'}</span></p>
                        {m.note && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"><span className="font-medium">备注：</span>{m.note}</div>}
                      </div>
                    </div>
                  );
                }
                const isIn = m.type === 'in';
                return (
                  <div key={`movement_${m.id}`} className="flex items-center gap-3 p-3.5 hover:bg-gray-50">
                    <div className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center ${
                      isIn ? 'bg-green-50' : 'bg-blue-50'
                    }`}>
                      {isIn ? (
                        <ArrowDownToLine className="w-5 h-5 text-green-600" />
                      ) : (
                        <ArrowUpFromLine className="w-5 h-5 text-blue-600" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm text-gray-900 truncate">{m.product_name || '已删除商品'}</p>
                        {m.variant_size && <span className="badge bg-purple-50 text-purple-600">{m.variant_size}</span>}
                        {m.product_image && (
                          <img src={m.product_image} alt="" className="w-4 h-4 rounded object-cover flex-shrink-0" />
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-400">{formatDate(m.created_at)}</span>
                        {m.variant_barcode && <span className="text-xs font-mono text-gray-400">· {m.variant_barcode}</span>}
                        {m.reason && <span className="text-xs text-gray-400">· {m.reason}</span>}
                        {m.operator && <span className="text-xs text-gray-400">· {m.operator}</span>}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`font-bold text-sm ${isIn ? 'text-green-600' : 'text-blue-600'}`}>
                        {isIn ? '+' : '−'}{m.quantity}
                      </p>
                      <p className="text-xs text-gray-400">{m.product_unit || '个'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-40"
              >
                上一页
              </button>
              <span className="text-sm text-gray-500 px-2">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
