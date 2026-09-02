import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, Factory, History, User, Plus, Pencil, Trash2 } from 'lucide-react';
import { getProductChanges } from '../api/client';
import useSyncRefresh from '../lib/useSyncRefresh';

const actionMeta = {
  create: { label: '创建商品', color: 'text-green-600', bg: 'bg-green-50', Icon: Plus },
  update: { label: '编辑商品', color: 'text-purple-600', bg: 'bg-purple-50', Icon: Pencil },
  delete: { label: '删除商品', color: 'text-red-600', bg: 'bg-red-50', Icon: Trash2 },
};

const getChangeMeta = change => {
  if (change.field === '待出货转销售库存') {
    return { label: '待出货入库销售', color: 'text-green-600', bg: 'bg-green-50', Icon: ArrowDownToLine };
  }
  if (change.field === '待出货库存录入') {
    return { label: '录入待出货库存', color: 'text-amber-600', bg: 'bg-amber-50', Icon: Factory };
  }
  if (change.field === '待出货库存调整') {
    return { label: '调整待出货库存', color: 'text-blue-600', bg: 'bg-blue-50', Icon: Factory };
  }
  return actionMeta[change.action] || actionMeta.update;
};

export default function ProductChangesViewer({ product, onClose }) {
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadChanges = useCallback(async () => {
    try {
      const res = await getProductChanges(product.id);
      setChanges(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to load product changes:', err);
      setChanges([]);
    } finally {
      setLoading(false);
    }
  }, [product.id]);

  useEffect(() => { loadChanges(); }, [loadChanges]);
  useSyncRefresh(loadChanges, ['product_changes']);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const diff = Date.now() - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="fixed inset-0 z-[60] bg-gray-50 flex flex-col">
      {/* Header */}
      <div
        className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 flex-shrink-0"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <button onClick={onClose} className="p-1 -ml-1 hover:bg-gray-100 rounded-lg flex items-center justify-center">
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>
        <h2 className="font-bold text-gray-900 flex-1 truncate">{product.name} · 变更记录</h2>
      </div>

      {/* Change list */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-lg mx-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : changes.length === 0 ? (
            <div className="card p-12 text-center text-gray-400 text-sm">
              <History className="w-10 h-10 mx-auto mb-2 text-gray-300" />
              暂无变更记录
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="divide-y divide-gray-50">
                {changes.map(c => {
                  const meta = getChangeMeta(c);
                  const Icon = meta.Icon;
                  const effectiveAction = c.action || 'update';
                  return (
                    <div key={c.id} className="flex items-start gap-3 p-3.5">
                      <div className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center ${meta.bg}`}>
                        <Icon className={`w-5 h-5 ${meta.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm text-gray-900">{meta.label}</p>
                          {c.product_image && (
                            <img src={c.product_image} alt="" className="w-4 h-4 rounded object-cover flex-shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-400">{formatDate(c.created_at)}</span>
                          {c.user_name && (
                            <span className="flex items-center gap-0.5 text-xs text-purple-500">
                              <User className="w-3 h-3" />
                              {c.user_name}
                            </span>
                          )}
                        </div>
                        {effectiveAction === 'update' ? (
                          c.field === '图片' ? (
                            <p className="text-xs text-gray-500 mt-1">
                              <span className="font-medium">{c.field}</span>
                              <span className="text-gray-300 mx-1">·</span>
                              <span>已更新</span>
                            </p>
                          ) : (
                            <p className="text-xs text-gray-500 mt-1">
                              <span className="font-medium">{c.field}</span>
                              <span className="text-gray-300 mx-1">·</span>
                              <span className="text-gray-400 line-through">{c.old_value || '(空)'}</span>
                              <span className="mx-1 text-gray-300">→</span>
                              <span>{c.new_value || '(空)'}</span>
                            </p>
                          )
                        ) : (
                          <p className="text-xs text-gray-500 mt-1">{c.new_value || c.field}</p>
                        )}
                        {c.note && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"><span className="font-medium">备注：</span>{c.note}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
