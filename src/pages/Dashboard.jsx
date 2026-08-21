import { useCallback, useEffect, useState } from 'react';
import { Package, AlertTriangle, Boxes, ArrowDownToLine, ArrowUpFromLine, X, CalendarDays, CircleCheck } from 'lucide-react';
import { getInventory, getMovements } from '../api/client';
import useSyncRefresh from '../lib/useSyncRefresh';

export default function Dashboard({ onNavigate, canManage = true }) {
  const [data, setData] = useState(null);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailType, setDetailType] = useState(null);
  const [showLowStockDetails, setShowLowStockDetails] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [invRes, movRes] = await Promise.all([getInventory(), getMovements({ pageSize: 1000 })]);
      setData(invRes.data);
      const movList = movRes?.data?.data || [];
      setMovements(movList);
    } catch (err) {
      console.error('Failed to load inventory:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useSyncRefresh(loadData);

  useEffect(() => {
    if (!detailType && !showLowStockDetails) return undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => { if (event.key === 'Escape') { setDetailType(null); setShowLowStockDetails(false); } };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [detailType, showLowStockDetails]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 今日动态：今天 00:00 起至今的入库/出库数量、新建商品数
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const isToday = (ts) => ts && new Date(ts) >= todayStart;
  const todayMovements = movements.filter(m => isToday(m.created_at));
  const todayInItems = todayMovements.filter(m => m.type === 'in');
  const todayOutItems = todayMovements.filter(m => m.type === 'out');
  const todayIn = todayInItems
    .reduce((s, m) => s + (Number(m.quantity) || 0), 0);
  const todayOut = todayOutItems
    .reduce((s, m) => s + (Number(m.quantity) || 0), 0);
  const todayNewProductItems = (data?.products || []).filter(p => isToday(p.created_at));
  const todayNewProducts = todayNewProductItems.length;
  const todayLabel = `${todayStart.getMonth() + 1}月${todayStart.getDate()}日`;
  const sevenDaysStart = new Date(todayStart);
  sevenDaysStart.setDate(sevenDaysStart.getDate() - 6);
  const sevenDayOutItems = movements.filter(
    m => m.type === 'out' && m.created_at && new Date(m.created_at) >= sevenDaysStart
  );
  const sevenDayOut = sevenDayOutItems
    .reduce((sum, movement) => sum + (Number(movement.quantity) || 0), 0);

  const detailConfig = {
    'today-in': { title: '今日入库详情', subtitle: todayLabel, items: todayInItems, kind: 'movement' },
    'today-out': { title: '今日出库详情', subtitle: todayLabel, items: todayOutItems, kind: 'movement' },
    'today-products': { title: '今日新建新品', subtitle: todayLabel, items: todayNewProductItems, kind: 'product' },
    'seven-day-out': {
      title: '近7日出库详情',
      subtitle: `${sevenDaysStart.getMonth() + 1}月${sevenDaysStart.getDate()}日 至 ${todayLabel}`,
      items: sevenDayOutItems,
      kind: 'movement',
    },
  };

  const stats = [
    { label: '商品总数', value: data?.totalProducts || 0, icon: Package, color: 'bg-blue-500' },
    { label: '库存总量', value: data?.totalStock || 0, icon: Boxes, color: 'bg-green-500' },
    { label: '库存预警', value: data?.lowStockCount || 0, icon: AlertTriangle, color: 'bg-orange-500' },
    { label: '近7日出库量', value: sevenDayOut, icon: ArrowUpFromLine, color: 'bg-purple-500', detail: 'seven-day-out' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">库存预览</h1>
        <p className="text-sm text-gray-500 mt-0.5">实时查看库存状态与商品信息</p>
      </div>

      {/* 今日动态 */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="w-1.5 h-4 rounded-full bg-primary-500" />
          <h3 className="font-medium text-gray-900 text-sm">今日动态</h3>
          <span className="text-xs text-gray-400">{todayLabel}</span>
        </div>
        <div className="grid grid-cols-3 divide-x divide-gray-100">
          <button type="button" onClick={() => setDetailType('today-in')} className="flex flex-col items-center rounded-lg py-2 hover:bg-green-50 active:bg-green-100">
            <p className="text-2xl font-bold text-gray-900">{todayIn}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-gray-400">
              <ArrowDownToLine className="h-3.5 w-3.5 text-green-500" />
              入库数量
            </p>
          </button>
          <button type="button" onClick={() => setDetailType('today-out')} className="flex flex-col items-center rounded-lg py-2 hover:bg-blue-50 active:bg-blue-100">
            <p className="text-2xl font-bold text-gray-900">{todayOut}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-gray-400">
              <ArrowUpFromLine className="h-3.5 w-3.5 text-blue-500" />
              出库数量
            </p>
          </button>
          <button type="button" onClick={() => setDetailType('today-products')} className="flex flex-col items-center rounded-lg py-2 hover:bg-purple-50 active:bg-purple-100">
            <p className="text-2xl font-bold text-gray-900">{todayNewProducts}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-gray-400">
              <Package className="h-3.5 w-3.5 text-purple-500" />
              新建新品
            </p>
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map((stat, i) => {
          const Icon = stat.icon;
          const Card = stat.detail ? 'button' : 'div';
          return (
            <Card
              key={i}
              type={stat.detail ? 'button' : undefined}
              onClick={stat.detail ? () => setDetailType(stat.detail) : undefined}
              className={`card p-4 text-left ${stat.detail ? 'transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0' : ''}`}
            >
              <div className={`w-9 h-9 rounded-lg ${stat.color} flex items-center justify-center mb-2`}>
                <Icon className="w-5 h-5 text-white" />
              </div>
              <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
            </Card>
          );
        })}
      </div>

      {/* Low Stock Alert */}
      <div className={`card p-4 ${data?.lowStockVariants?.length > 0 ? 'border-orange-200 bg-orange-50' : 'border-green-200 bg-green-50'}`}>
        {data?.lowStockVariants?.length > 0 ? <>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-orange-500" />
            <h3 className="flex-1 font-medium text-orange-800 text-sm">尺码库存预警 ({data.lowStockVariants.length})</h3>
            {data.lowStockVariants.length > 5 && <button type="button" onClick={() => setShowLowStockDetails(true)} className="rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100">查看全部</button>}
          </div>
          <div className="flex flex-wrap gap-2">
            {data.lowStockVariants.slice(0, 5).map(variant => {
              const TagName = canManage ? 'button' : 'span';
              return (
              <TagName
                key={`${variant.product_id}_${variant.id}`}
                onClick={canManage ? () => onNavigate('stock-in', { productId: variant.product_id, variantId: variant.id, source: 'low-stock-alert' }) : undefined}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 bg-white rounded-lg text-xs text-orange-700 border border-orange-200 ${canManage ? 'hover:bg-orange-100 cursor-pointer' : ''}`}
              >
                {variant.product_image && <img src={variant.product_image} alt="" className="w-4 h-4 rounded object-cover" />}
                {variant.product_name} · {variant.size}
                <span className="text-orange-400">({variant.current_stock}/{variant.min_stock}{variant.product_unit})</span>
              </TagName>
            );})}
          </div>
        </> : <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-green-600"><CircleCheck className="h-5 w-5" /></span>
          <div>
            <h3 className="text-sm font-medium text-green-800">尺码库存预警 (0)</h3>
            <p className="mt-0.5 text-xs text-green-600">当前没有达到预警值的商品尺码</p>
          </div>
        </div>}
      </div>

      {/* Quick Actions */}
      {canManage && <div className="grid grid-cols-2 gap-3">
        <button onClick={() => onNavigate('stock-in')} className="card p-4 flex items-center gap-3 hover:shadow-md transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
            <ArrowDownToLine className="w-5 h-5 text-green-600" />
          </div>
          <div className="text-left">
            <p className="font-medium text-sm text-gray-900">入库</p>
            <p className="text-xs text-gray-400">增加库存</p>
          </div>
        </button>
        <button onClick={() => onNavigate('stock-out')} className="card p-4 flex items-center gap-3 hover:shadow-md transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
            <ArrowUpFromLine className="w-5 h-5 text-blue-600" />
          </div>
          <div className="text-left">
            <p className="font-medium text-sm text-gray-900">出库</p>
            <p className="text-xs text-gray-400">减少库存</p>
          </div>
        </button>
      </div>}

      {detailType && (
        <DashboardDetailModal
          config={detailConfig[detailType]}
          onClose={() => setDetailType(null)}
        />
      )}

      {showLowStockDetails && (
        <LowStockDetailModal
          items={data?.lowStockVariants || []}
          canManage={canManage}
          onSelect={(variant) => {
            setShowLowStockDetails(false);
            onNavigate('stock-in', { productId: variant.product_id, variantId: variant.id, source: 'low-stock-alert' });
          }}
          onClose={() => setShowLowStockDetails(false)}
        />
      )}
    </div>
  );
}

function LowStockDetailModal({ items, canManage, onSelect, onClose }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5">
          <div><h3 className="font-semibold text-gray-900">全部尺码库存预警</h3><p className="mt-0.5 text-xs text-gray-400">共 {items.length} 个尺码需要关注{canManage ? ' · 点击可快捷入库' : ''}</p></div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 divide-y divide-gray-100 overflow-y-auto">
          {items.map(variant => {
            const Row = canManage ? 'button' : 'div';
            return (
              <Row key={`${variant.product_id}_${variant.id}`} type={canManage ? 'button' : undefined} onClick={canManage ? () => onSelect(variant) : undefined} className={`flex w-full items-center gap-3 px-4 py-3 text-left ${canManage ? 'hover:bg-orange-50' : ''}`}>
                <ProductThumb src={variant.product_image} name={variant.product_name} />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-900">{variant.product_name}</p><p className="mt-0.5 text-xs text-gray-400">尺码 {variant.size} · 条形码 {variant.barcode || '—'}</p></div>
                <div className="shrink-0 text-right"><p className="text-sm font-semibold text-orange-600">{variant.current_stock} / {variant.min_stock}</p><p className="text-[10px] text-gray-400">当前 / 预警值</p></div>
              </Row>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DashboardDetailModal({ config, onClose }) {
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(timestamp));
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3.5">
          <div>
            <h3 className="font-semibold text-gray-900">{config.title}</h3>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-400">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{config.subtitle}</span>
              <span>· {config.items.length} 条记录</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {config.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-16 text-gray-400">
              <Package className="mb-2 h-9 w-9 text-gray-300" />
              <p className="text-sm">暂无相关记录</p>
            </div>
          ) : config.kind === 'product' ? (
            <div className="divide-y divide-gray-100">
              {config.items.map(product => (
                <div key={product.id} className="flex items-center gap-3 px-4 py-3">
                  <ProductThumb src={product.image_path} name={product.name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900">{product.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
                      {(product.variants || []).length > 0 && <span>{product.variants.length} 个尺码</span>}
                      {product.category && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500">{product.category}</span>}
                    </div>
                  </div>
                  <time className="shrink-0 text-xs text-gray-400">{formatTime(product.created_at)}</time>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {config.items.map(movement => (
                <div key={movement.id} className="flex items-center gap-3 px-4 py-3">
                  <ProductThumb src={movement.product_image} name={movement.product_name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-gray-900">{movement.product_name || '已删除商品'}</p>
                      <span className={`shrink-0 text-sm font-semibold ${movement.type === 'in' ? 'text-green-600' : 'text-blue-600'}`}>
                        {movement.type === 'in' ? '+' : '−'}{movement.quantity} {movement.product_unit || '个'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-gray-400">
                      {movement.variant_size ? `尺码 ${movement.variant_size} · ` : ''}{movement.reason || '未填写原因'}{movement.operator ? ` · ${movement.operator}` : ''}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-gray-400">{formatTime(movement.created_at)}</time>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProductThumb({ src, name }) {
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">
      {src ? <img src={src} alt={name || ''} className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-400" />}
    </div>
  );
}
