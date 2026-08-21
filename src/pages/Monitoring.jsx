import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, ChevronRight, Package, TrendingUp, X } from 'lucide-react';
import { getMovements, getProducts, getSyncDiagnostics } from '../api/client';
import useSyncRefresh from '../lib/useSyncRefresh';
import { ProductDetailPanel } from './Products';

const DAY = 24 * 60 * 60 * 1000;
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const startOfDay = value => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date; };
const formatShortDate = value => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
const formatTime = value => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '从未出库';

export default function Monitoring() {
  const [period, setPeriod] = useState(7);
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(null);
  const [detailProduct, setDetailProduct] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const [productRes, movementRes, diagnostics] = await Promise.all([
        getProducts(), getMovements({ pageSize: 1000 }), getSyncDiagnostics(),
      ]);
      setProducts(Array.isArray(productRes.data) ? productRes.data : []);
      setMovements(Array.isArray(movementRes?.data?.data) ? movementRes.data.data : []);
      setPending(diagnostics.pending || []);
    } catch (error) {
      console.error('Failed to load monitoring data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useSyncRefresh(loadData);

  const metrics = useMemo(() => {
    const today = startOfDay(new Date());
    const periodStart = new Date(today);
    periodStart.setDate(periodStart.getDate() - period + 1);
    const recent = movements.filter(item => new Date(item.created_at) >= periodStart);
    const days = Array.from({ length: period }, (_, index) => {
      const date = new Date(periodStart);
      date.setDate(date.getDate() + index);
      const key = dateKey(date);
      const entries = recent.filter(item => dateKey(new Date(item.created_at)) === key);
      const incoming = entries.filter(item => item.type === 'in').reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      const outgoing = entries.filter(item => item.type === 'out').reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      return { key, date, entries, incoming, outgoing, net: incoming - outgoing };
    });

    const outgoing = recent.filter(item => item.type === 'out');
    const totalOut = outgoing.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const productTotals = new Map();
    const variantTotals = new Map();
    for (const item of outgoing) {
      productTotals.set(item.product_id, (productTotals.get(item.product_id) || 0) + Number(item.quantity || 0));
      const variantKey = `${item.product_id}:${item.variant_id || item.variant_size || 'default'}`;
      const current = variantTotals.get(variantKey) || { product_id: item.product_id, size: item.variant_size || '默认规格', quantity: 0 };
      current.quantity += Number(item.quantity || 0);
      variantTotals.set(variantKey, current);
    }
    const productMap = new Map(products.map(product => [String(product.id), product]));
    const hotProducts = [...productTotals.entries()].map(([id, quantity]) => ({ product: productMap.get(String(id)), quantity }))
      .filter(item => item.product).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
    const hotVariants = [...variantTotals.values()].map(item => ({ ...item, product: productMap.get(String(item.product_id)) }))
      .filter(item => item.product).sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    const lastOutMap = new Map();
    for (const item of movements.filter(item => item.type === 'out')) {
      const timestamp = new Date(item.created_at).getTime();
      if (!lastOutMap.has(item.product_id) || timestamp > lastOutMap.get(item.product_id)) lastOutMap.set(item.product_id, timestamp);
    }
    const staleCutoff = today.getTime() - 30 * DAY;
    const staleProducts = products.filter(product => (product.current_stock || 0) > 0 && (!lastOutMap.get(product.id) || lastOutMap.get(product.id) < staleCutoff))
      .map(product => {
        const lastOut = lastOutMap.get(product.id) || null;
        const base = lastOut || new Date(product.created_at || 0).getTime();
        return { product, lastOut, idleDays: base > 0 ? Math.floor((Date.now() - base) / DAY) : null };
      }).sort((a, b) => (b.idleDays ?? 999999) - (a.idleDays ?? 999999));

    const anomalies = [];
    for (const item of movements.filter(item => Number(item.quantity) >= 50).slice(0, 20)) {
      anomalies.push({ id: `large_${item.id}`, time: item.created_at, level: 'warning', title: `单次${item.type === 'in' ? '入库' : '出库'}数量较大`, detail: `${item.product_name || '商品'} · ${item.variant_size || '默认规格'} · ${item.quantity}` });
    }
    const frequentGroups = new Map();
    for (const item of recent) {
      const slot = Math.floor(new Date(item.created_at).getTime() / (30 * 60 * 1000));
      const key = `${item.product_id}:${item.variant_id || item.variant_size}:${slot}`;
      const group = frequentGroups.get(key) || [];
      group.push(item);
      frequentGroups.set(key, group);
    }
    for (const group of frequentGroups.values()) {
      if (group.length >= 3) anomalies.push({ id: `frequent_${group[0].id}`, time: group[0].created_at, level: 'warning', title: '同一尺码短时间频繁操作', detail: `${group[0].product_name} · ${group[0].variant_size || '默认规格'} · 30分钟内 ${group.length} 次` });
    }
    const todayOut = movements.filter(item => item.type === 'out' && new Date(item.created_at) >= today);
    for (const product of products) {
      for (const variant of product.variants || []) {
        if ((variant.current_stock || 0) !== 0) continue;
        const quantity = todayOut.filter(item => item.product_id === product.id && item.variant_id === variant.id).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        if (quantity > 0) anomalies.push({ id: `zero_${product.id}_${variant.id}`, time: new Date().toISOString(), level: 'danger', title: '尺码今日归零', detail: `${product.name} · ${variant.size} · 今日出库 ${quantity}` });
      }
    }
    for (const item of pending.filter(item => Date.now() - new Date(item.created_at).getTime() > 10 * 60 * 1000)) {
      anomalies.push({ id: `pending_${item.id}`, time: item.created_at, level: 'danger', title: '待同步操作长时间未完成', detail: `已等待 ${Math.floor((Date.now() - new Date(item.created_at).getTime()) / 60000)} 分钟` });
    }
    anomalies.sort((a, b) => new Date(b.time) - new Date(a.time));
    return { days, totalOut, hotProducts, hotVariants, staleProducts, anomalies };
  }, [movements, pending, period, products]);

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" /></div>;

  const maxDaily = Math.max(1, ...metrics.days.flatMap(day => [day.incoming, day.outgoing]));
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div><h1 className="text-xl font-bold text-gray-900">数据监控</h1><p className="mt-0.5 text-sm text-gray-500">库存流动、动销排行与异常提醒</p></div>
        <div className="flex rounded-lg bg-gray-100 p-1">
          {[7, 30].map(value => <button key={value} onClick={() => setPeriod(value)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${period === value ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-500'}`}>{value}日</button>)}
        </div>
      </div>

      <section className="card overflow-hidden p-4">
        <SectionTitle icon={TrendingUp} title={`近 ${period} 日出入库趋势`} subtitle="点击日期查看当天流水" />
        <div className="mb-3 flex gap-4 text-xs text-gray-500"><Legend color="bg-green-500" text="入库" /><Legend color="bg-blue-500" text="出库" /><Legend color="bg-gray-400" text="净变化" /></div>
        <div className="overflow-x-auto pb-1">
          <div className={`flex h-52 items-end gap-1 ${period === 30 ? 'min-w-[760px]' : 'min-w-full'}`}>
            {metrics.days.map(day => (
              <button key={day.key} onClick={() => setSelectedDay(day)} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-lg px-0.5 hover:bg-gray-50">
                <span className={`mb-1 text-[10px] font-medium ${day.net > 0 ? 'text-green-600' : day.net < 0 ? 'text-blue-600' : 'text-gray-400'}`}>{day.net > 0 ? '+' : ''}{day.net}</span>
                <div className="flex h-36 items-end gap-0.5">
                  <span className="w-2 rounded-t bg-green-400 transition-all group-hover:bg-green-500" style={{ height: `${Math.max(day.incoming ? 4 : 0, day.incoming / maxDaily * 100)}%` }} />
                  <span className="w-2 rounded-t bg-blue-400 transition-all group-hover:bg-blue-500" style={{ height: `${Math.max(day.outgoing ? 4 : 0, day.outgoing / maxDaily * 100)}%` }} />
                </div>
                <span className="mt-2 whitespace-nowrap text-[10px] text-gray-400">{formatShortDate(day.date)}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankingCard title={`热销商品 Top 5 · ${period}日`} items={metrics.hotProducts.map(item => ({ product: item.product, label: item.product.name, sub: `${item.product.variants?.length || 0} 个尺码`, quantity: item.quantity }))} total={metrics.totalOut} onProduct={setDetailProduct} />
        <RankingCard title={`热销尺码 Top 5 · ${period}日`} items={metrics.hotVariants.map(item => ({ product: item.product, label: `${item.product.name} · ${item.size}`, sub: '尺码出库', quantity: item.quantity }))} total={metrics.totalOut} onProduct={setDetailProduct} />
      </div>

      <section className="card overflow-hidden">
        <div className="p-4"><SectionTitle icon={Boxes} title="滞销库存监测" subtitle="30天无出库且仍有库存" /></div>
        {metrics.staleProducts.length ? <div className="divide-y divide-gray-100">{metrics.staleProducts.map(item => (
          <button key={item.product.id} onClick={() => setDetailProduct(item.product)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50">
            <ProductImage product={item.product} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-900">{item.product.name}</p><p className="mt-0.5 text-xs text-gray-400">最后出库：{item.lastOut ? formatTime(item.lastOut) : '从未出库'}{item.idleDays != null ? ` · ${item.idleDays}天` : ''}</p></div><div className="text-right"><p className="text-sm font-semibold text-orange-600">{item.product.current_stock}</p><p className="text-[10px] text-gray-400">积压库存</p></div><ChevronRight className="h-4 w-4 text-gray-300" />
          </button>
        ))}</div> : <Empty text="暂无滞销库存" />}
      </section>

      <section className="card overflow-hidden">
        <div className="p-4"><SectionTitle icon={AlertTriangle} title="库存异动提醒" subtitle="单次≥50、30分钟≥3次、归零与同步异常" /></div>
        {metrics.anomalies.length ? <div className="divide-y divide-gray-100">{metrics.anomalies.slice(0, 30).map(item => (
          <div key={item.id} className="flex gap-3 px-4 py-3"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${item.level === 'danger' ? 'bg-red-500' : 'bg-orange-400'}`} /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-800">{item.title}</p><p className="mt-0.5 text-xs text-gray-400">{item.detail}</p></div><time className="shrink-0 text-[11px] text-gray-400">{formatTime(item.time)}</time></div>
        ))}</div> : <Empty text="暂未发现库存异动" />}
      </section>

      {selectedDay && <DayDetail day={selectedDay} onClose={() => setSelectedDay(null)} />}
      {detailProduct && <ProductDetailPanel product={detailProduct} onClose={() => setDetailProduct(null)} />}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }) { return <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50"><Icon className="h-4 w-4 text-primary-600" /></span><div><h2 className="text-sm font-semibold text-gray-900">{title}</h2><p className="text-[11px] text-gray-400">{subtitle}</p></div></div>; }
function Legend({ color, text }) { return <span className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${color}`} />{text}</span>; }
function ProductImage({ product }) { return <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">{product.image_path ? <img src={product.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-300" />}</div>; }
function Empty({ text }) { return <div className="px-4 py-10 text-center text-sm text-gray-400">{text}</div>; }

function RankingCard({ title, items, total, onProduct }) {
  return <section className="card overflow-hidden"><div className="border-b border-gray-100 px-4 py-3"><h2 className="text-sm font-semibold text-gray-900">{title}</h2></div>{items.length ? <div className="divide-y divide-gray-100">{items.map((item, index) => { const percent = total ? Math.round(item.quantity / total * 100) : 0; return <button key={`${item.product.id}_${item.label}`} onClick={() => onProduct(item.product)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${index < 3 ? 'bg-orange-50 text-orange-600' : 'bg-gray-100 text-gray-500'}`}>{index + 1}</span><ProductImage product={item.product} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-900">{item.label}</p><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-primary-500" style={{ width: `${percent}%` }} /></div></div><div className="text-right"><p className="text-sm font-semibold text-gray-900">{item.quantity}</p><p className="text-[10px] text-gray-400">{percent}%</p></div></button>; })}</div> : <Empty text="该周期暂无出库数据" />}</section>;
}

function DayDetail({ day, onClose }) {
  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}><div className="max-h-[80dvh] w-full max-w-lg overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl" onClick={event => event.stopPropagation()}><div className="flex items-center justify-between border-b border-gray-100 px-4 py-3"><div><h3 className="font-semibold text-gray-900">{formatShortDate(day.date)} 出入库流水</h3><p className="text-xs text-gray-400">入库 {day.incoming} · 出库 {day.outgoing} · 净变化 {day.net > 0 ? '+' : ''}{day.net}</p></div><button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button></div><div className="max-h-[65dvh] overflow-y-auto">{day.entries.length ? <div className="divide-y divide-gray-100">{day.entries.map(item => <div key={item.id} className="flex items-center gap-3 px-4 py-3"><span className={`flex h-9 w-9 items-center justify-center rounded-lg ${item.type === 'in' ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'}`}>{item.type === 'in' ? <ArrowDownToLine className="h-4 w-4" /> : <ArrowUpFromLine className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.product_name} · {item.variant_size || '默认规格'}</p><p className="mt-0.5 text-xs text-gray-400">{item.reason || '未填写原因'} · {formatTime(item.created_at)}</p></div><span className={`font-semibold ${item.type === 'in' ? 'text-green-600' : 'text-blue-600'}`}>{item.type === 'in' ? '+' : '−'}{item.quantity}</span></div>)}</div> : <Empty text="当天暂无流水" />}</div></div></div>;
}
