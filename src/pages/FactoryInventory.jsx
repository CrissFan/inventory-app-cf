import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Boxes, Calculator, CheckCircle2, ClipboardList, Factory, LoaderCircle, Package, Pencil, Plus, Search, X } from 'lucide-react';
import { addFactoryInventory, getFactoryInventory, getFactoryInventoryHistory, getProducts, setFactoryInventory, transferFactoryInventory } from '../api/client';
import { useAuth } from '../AuthContext';
import ProductTagBadges from '../components/ProductTagBadges';
import useSyncRefresh from '../lib/useSyncRefresh';

export default function FactoryInventory() {
  const { user } = useAuth();
  const canManage = user?.role !== 'viewer';
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editorItem, setEditorItem] = useState(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [transferItem, setTransferItem] = useState(null);
  const [message, setMessage] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const [factoryResponse, productsResponse] = await Promise.all([getFactoryInventory(), getProducts()]);
      setItems(Array.isArray(factoryResponse.data) ? factoryResponse.data : []);
      setProducts((Array.isArray(productsResponse.data) ? productsResponse.data : []).filter(product => (product.status || 'done') === 'done'));
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || error.message || '待出货库存加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useSyncRefresh(loadData);

  const activeItems = useMemo(() => items.filter(item => item.total_quantity > 0), [items]);
  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (!keyword) return activeItems;
    return activeItems.filter(item => [item.product?.name, item.product?.category, item.product?.sub_tags, ...(item.variants || []).flatMap(variant => [variant.size, variant.barcode])]
      .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [activeItems, search]);
  const totalPending = activeItems.reduce((sum, item) => sum + item.total_quantity, 0);

  const openEditor = item => { setEditorItem(item || null); setShowEditor(true); setMessage(null); };
  const handleSaved = async text => { setShowEditor(false); setEditorItem(null); setMessage({ type: 'success', text }); await loadData(); };
  const handleTransferred = async text => { setTransferItem(null); setMessage({ type: 'success', text }); await loadData(); };

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div><h1 className="text-xl font-bold text-gray-900">工厂待出货</h1><p className="mt-0.5 text-sm text-gray-500">管理尚未进入销售仓库的商品</p></div>
        <div className="flex w-full gap-2 overflow-x-auto pb-1 sm:w-auto">
          <button type="button" onClick={() => setShowHistory(true)} className="btn-secondary shrink-0"><ClipboardList className="h-4 w-4" />录入历史</button>
          <button type="button" onClick={() => setShowCalculator(true)} className="btn-secondary shrink-0"><Calculator className="h-4 w-4" />补货计算</button>
          {canManage && <button type="button" onClick={() => openEditor(null)} className="btn-primary shrink-0"><Plus className="h-4 w-4" />录入待出货</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="card p-4"><div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50"><Factory className="h-5 w-5 text-amber-600" /></div><p className="text-2xl font-bold text-gray-900">{activeItems.length}</p><p className="text-xs text-gray-500">待出货商品</p></div>
        <div className="card p-4"><div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50"><Boxes className="h-5 w-5 text-blue-600" /></div><p className="text-2xl font-bold text-gray-900">{totalPending}</p><p className="text-xs text-gray-500">待出货总数量</p></div>
      </div>

      {message && <div className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>{message.type === 'error' ? <X className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}{message.text}</div>}

      <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input className="input pl-9" placeholder="搜索商品名称、标签、尺码或条形码" value={search} onChange={event => setSearch(event.target.value)} /></div>

      {loading ? <div className="flex h-48 items-center justify-center"><LoaderCircle className="h-8 w-8 animate-spin text-primary-500" /></div>
        : filteredItems.length === 0 ? <div className="card p-12 text-center text-sm text-gray-400"><Factory className="mx-auto mb-3 h-11 w-11 text-gray-300" /><p>{search ? '未找到匹配的待出货商品' : '暂无待出货商品'}</p>{canManage && !search && <button type="button" onClick={() => openEditor(null)} className="btn-primary mx-auto mt-4"><Plus className="h-4 w-4" />录入第一件商品</button>}</div>
        : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{filteredItems.map(item => <FactoryCard key={item.id} item={item} canManage={canManage} onEdit={() => openEditor(item)} onTransfer={() => setTransferItem(item)} />)}</div>}

      {showEditor && <FactoryInventoryEditor products={products} items={items} initialItem={editorItem} onClose={() => { setShowEditor(false); setEditorItem(null); }} onSaved={handleSaved} />}
      {showHistory && <FactoryInventoryHistory onClose={() => setShowHistory(false)} />}
      {showCalculator && <ReplenishmentCalculator products={products} items={items} onClose={() => setShowCalculator(false)} />}
      {transferItem && <FactoryTransferModal item={transferItem} operator={user?.display_name || ''} onClose={() => setTransferItem(null)} onTransferred={handleTransferred} />}
    </div>
  );
}

function FactoryInventoryHistory({ onClose }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  useEffect(() => {
    const timer = setTimeout(() => { setPage(1); setDebouncedSearch(search.trim()); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getFactoryInventoryHistory({ page, pageSize, search: debouncedSearch });
      setRecords(Array.isArray(response?.data?.data) ? response.data.data : []);
      setTotal(response?.data?.total || 0);
    } catch {
      setRecords([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page]);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useSyncRefresh(loadHistory);

  const formatDate = value => new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return <div className="fixed inset-0 z-[86] flex flex-col bg-gray-50">
    <header className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-4 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}><button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100"><X className="h-5 w-5 text-gray-500" /></button><div><h2 className="font-bold text-gray-900">待出货录入历史</h2><p className="text-xs text-gray-400">查看每次录入的尺码数量与备注</p></div></header>
    <main className="flex-1 overflow-y-auto p-4"><div className="mx-auto max-w-3xl space-y-4 pb-6">
      <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input className="input pl-9 pr-10" placeholder="搜索商品、录入数量或备注" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>}</div>
      {loading ? <div className="flex h-48 items-center justify-center"><LoaderCircle className="h-8 w-8 animate-spin text-primary-500" /></div>
        : records.length === 0 ? <div className="card p-12 text-center text-sm text-gray-400"><ClipboardList className="mx-auto mb-3 h-10 w-10 text-gray-300" />{debouncedSearch ? '未找到匹配的录入记录' : '暂无待出货录入记录'}</div>
        : <><div className="card divide-y divide-gray-100 overflow-hidden">{records.map(record => <article key={record.id} className="p-4">
          <div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-amber-50">{record.product_image ? <img src={record.product_image} alt="" className="h-full w-full object-cover" /> : <Factory className="h-5 w-5 text-amber-600" />}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold text-gray-900">{record.product_name || '已删除商品'}</h3><span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">待出货录入</span></div><p className="mt-0.5 text-xs text-gray-400">{formatDate(record.created_at)}{record.user_name ? ` · ${record.user_name}` : ''}</p></div></div>
          <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-600"><p>{record.new_value || '未记录数量明细'}</p><p className="mt-1 text-gray-400">{record.old_value || ''}</p></div>
          {record.note && <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800"><span className="font-medium">备注：</span>{record.note}</div>}
        </article>)}</div>{totalPages > 1 && <div className="flex items-center justify-center gap-3"><button type="button" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))} className="btn-secondary disabled:opacity-40">上一页</button><span className="text-sm text-gray-500">{page} / {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))} className="btn-secondary disabled:opacity-40">下一页</button></div>}</>}
    </div></main>
  </div>;
}

function ReplenishmentCalculator({ products, items, onClose }) {
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [search, setSearch] = useState('');
  const [orders, setOrders] = useState({});

  const candidates = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (!keyword) return products;
    return products.filter(product => [
      product.name, product.category, product.sub_tags,
      ...(product.variants || []).flatMap(variant => [variant.size, variant.barcode]),
    ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [products, search]);

  const chooseProduct = product => {
    setSelectedProduct(product);
    setOrders(Object.fromEntries((product.variants || []).map(variant => [variant.id, ''])));
  };

  const factoryItem = useMemo(() => selectedProduct
    ? items.find(item => String(item.product_id) === String(selectedProduct.id))
    : null, [items, selectedProduct]);

  const rows = useMemo(() => {
    if (!selectedProduct) return [];
    return (selectedProduct.variants || []).map(variant => {
      const orderQuantity = Math.max(0, Number.parseInt(orders[variant.id], 10) || 0);
      const salesStock = Math.max(0, Number(variant.current_stock) || 0);
      const factoryStock = Math.max(0, Number(factoryItem?.variants?.find(item => String(item.id) === String(variant.id))?.quantity) || 0);
      const difference = orderQuantity - salesStock - factoryStock;
      return { ...variant, orderQuantity, salesStock, factoryStock, difference, suggested: Math.max(0, difference) };
    });
  }, [factoryItem, orders, selectedProduct]);

  const totals = useMemo(() => rows.reduce((result, row) => ({
    order: result.order + row.orderQuantity,
    sales: result.sales + row.salesStock,
    factory: result.factory + row.factoryStock,
    suggested: result.suggested + row.suggested,
  }), { order: 0, sales: 0, factory: 0, suggested: 0 }), [rows]);

  return <div className="fixed inset-0 z-[85] flex flex-col bg-gray-50">
    <header className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-4 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100"><X className="h-5 w-5 text-gray-500" /></button>
      <div className="min-w-0 flex-1"><h2 className="font-bold text-gray-900">补货计算</h2><p className="truncate text-xs text-gray-400">差数 = 订单数量 - 销售库存 - 工厂待出货库存</p></div>
    </header>
    <main className="flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4 pb-6">
        {!selectedProduct ? <>
          <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input className="input pl-9" placeholder="搜索并选择需要计算的商品" value={search} onChange={event => setSearch(event.target.value)} autoFocus /></div>
          <div className="card divide-y divide-gray-100">
            {candidates.length ? candidates.map(product => <button key={product.id} type="button" onClick={() => chooseProduct(product)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-gray-50">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">{product.image_path ? <img src={product.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-300" />}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-gray-800">{product.name}</span><span className="text-xs text-gray-400">{product.variants?.length || 0} 个尺码 · 销售库存 {product.current_stock || 0}</span></span>
            </button>) : <div className="p-10 text-center text-sm text-gray-400">未找到匹配商品</div>}
          </div>
        </> : <>
          <div className="card flex items-center gap-3 p-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100">{selectedProduct.image_path ? <img src={selectedProduct.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-300" />}</span>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-gray-900">{selectedProduct.name}</p><ProductTagBadges product={selectedProduct} max={3} className="mt-1" /></div>
            <button type="button" onClick={() => { setSelectedProduct(null); setSearch(''); }} className="text-xs font-medium text-primary-600">更换商品</button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="card p-3"><p className="text-xs text-gray-400">订单总量</p><p className="mt-1 text-xl font-bold text-gray-900">{totals.order}</p></div>
            <div className="card p-3"><p className="text-xs text-gray-400">销售库存</p><p className="mt-1 text-xl font-bold text-blue-600">{totals.sales}</p></div>
            <div className="card p-3"><p className="text-xs text-gray-400">待出货库存</p><p className="mt-1 text-xl font-bold text-amber-600">{totals.factory}</p></div>
            <div className="card p-3"><p className="text-xs text-gray-400">建议补货</p><p className="mt-1 text-xl font-bold text-red-600">{totals.suggested}</p></div>
          </div>

          <section className="card overflow-hidden">
            <div className="border-b border-gray-100 px-4 py-3"><h3 className="text-sm font-medium text-gray-800">按尺码输入当前订单数量</h3><p className="mt-0.5 text-xs text-gray-400">差数大于 0 时为建议补货量，小于等于 0 时无需补货</p></div>
            <div className="divide-y divide-gray-100">{rows.map(row => <div key={row.id} className="p-4">
              <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-gray-800">{row.size || '未命名尺码'}</p><p className="truncate font-mono text-xs text-gray-400">{row.barcode || '无条形码'}</p></div><label className="flex items-center gap-2 text-xs text-gray-500"><span>订单</span><input type="number" min="0" step="1" placeholder="0" value={orders[row.id] ?? ''} onChange={event => setOrders(current => ({ ...current, [row.id]: event.target.value }))} className="input h-10 w-24 text-center font-semibold" aria-label={`${row.size}订单数量`} /></label></div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center"><div className="rounded-lg bg-blue-50 px-2 py-2"><p className="text-[10px] text-blue-500">销售库存</p><p className="text-sm font-semibold text-blue-700">{row.salesStock}</p></div><div className="rounded-lg bg-amber-50 px-2 py-2"><p className="text-[10px] text-amber-500">待出货</p><p className="text-sm font-semibold text-amber-700">{row.factoryStock}</p></div><div className="rounded-lg bg-gray-50 px-2 py-2"><p className="text-[10px] text-gray-400">差数</p><p className={`text-sm font-semibold ${row.difference > 0 ? 'text-red-600' : 'text-green-600'}`}>{Math.abs(row.difference)}</p></div><div className={`rounded-lg px-2 py-2 ${row.suggested > 0 ? 'bg-red-50' : 'bg-gray-50'}`}><p className={`text-[10px] ${row.suggested > 0 ? 'text-red-500' : 'text-gray-400'}`}>建议补货</p><p className={`text-sm font-semibold ${row.suggested > 0 ? 'text-red-700' : 'text-gray-500'}`}>{row.suggested}</p></div></div>
            </div>)}</div>
          </section>
        </>}
      </div>
    </main>
    <footer className="shrink-0 border-t border-gray-200 bg-white px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}><div className="mx-auto flex max-w-3xl justify-end"><button type="button" onClick={onClose} className="btn-primary min-w-28">完成</button></div></footer>
  </div>;
}

function FactoryCard({ item, canManage, onEdit, onTransfer }) {
  const product = item.product || {};
  const visibleVariants = item.variants.filter(variant => variant.quantity > 0);
  return <article className="card flex h-full flex-col overflow-hidden">
    <div className="flex items-start gap-3 p-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100">{product.image_path ? <img src={product.image_path} alt={product.name} className="h-full w-full object-cover" /> : <Package className="h-6 w-6 text-gray-300" />}</div>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold text-gray-900">{product.name}</h3><span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">待出货 · doing</span></div><p className="mt-1 text-xs text-gray-400">待出货合计 <span className="font-semibold text-amber-600">{item.total_quantity}</span> {product.unit || '个'}</p><ProductTagBadges product={product} max={2} className="mt-1.5" /></div>
    </div>
    <div className="flex-1 space-y-1.5 px-4 pb-4">{visibleVariants.map(variant => <div key={variant.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs"><div className="min-w-0"><span className="font-medium text-gray-700">{variant.size}</span><span className="ml-2 font-mono text-gray-400">{variant.barcode}</span></div><span className="shrink-0 font-semibold text-amber-600">{variant.quantity}</span></div>)}</div>
    {canManage && <div className="mt-auto flex border-t border-gray-100"><button type="button" onClick={onEdit} className="flex flex-1 items-center justify-center gap-1 py-2.5 text-xs font-medium text-gray-600 hover:bg-gray-50"><Pencil className="h-3.5 w-3.5" />修改数量</button><div className="w-px bg-gray-100" /><button type="button" onClick={onTransfer} className="flex flex-1 items-center justify-center gap-1 py-2.5 text-xs font-medium text-green-600 hover:bg-green-50"><ArrowDownToLine className="h-3.5 w-3.5" />入库销售</button></div>}
  </article>;
}

function FactoryInventoryEditor({ products, items, initialItem, onClose, onSaved }) {
  const [selectedProduct, setSelectedProduct] = useState(initialItem?.product || null);
  const [search, setSearch] = useState('');
  const [quantities, setQuantities] = useState(() => Object.fromEntries((initialItem?.variants || []).map(variant => [variant.id, variant.quantity])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const candidates = products.filter(product => !search.trim() || [product.name, product.category, product.sub_tags, ...(product.variants || []).flatMap(variant => [variant.size, variant.barcode])].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search.trim().toLocaleLowerCase('zh-CN'))));

  const chooseProduct = product => {
    setSelectedProduct(product);
    setQuantities(Object.fromEntries((product.variants || []).map(variant => [variant.id, 0])));
    setError('');
  };
  const submit = async event => {
    event.preventDefault();
    if (!selectedProduct) { setError('请选择商品'); return; }
    setSaving(true); setError('');
    try {
      const variants = (selectedProduct.variants || []).map(variant => ({ id: variant.id, quantity: Math.max(0, Number.parseInt(quantities[variant.id], 10) || 0) }));
      if (initialItem) await setFactoryInventory(selectedProduct.id, variants);
      else await addFactoryInventory(selectedProduct.id, variants, note);
      await onSaved(initialItem
        ? `已调整「${selectedProduct.name}」的待出货数量`
        : `本次录入已合并到「${selectedProduct.name}」的待出货库存`);
    } catch (submitError) { setError(submitError.response?.data?.error || submitError.message || '保存失败'); }
    finally { setSaving(false); }
  };

  return <div className="fixed inset-0 z-[80] flex flex-col bg-gray-50">
    <header className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-4 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}><button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100"><X className="h-5 w-5 text-gray-500" /></button><div><h2 className="font-bold text-gray-900">{initialItem ? '修改待出货数量' : '录入待出货商品'}</h2><p className="text-xs text-gray-400">{initialItem ? '直接调整当前汇总数量' : '填写本次新增数量，保存后自动与已有库存合并'}</p></div></header>
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col"><main className="flex-1 overflow-y-auto p-4"><div className="mx-auto max-w-2xl space-y-4 pb-6">
      {error && <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
      {!selectedProduct ? <><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input className="input pl-9" placeholder="搜索要录入的销售商品" value={search} onChange={event => setSearch(event.target.value)} autoFocus /></div><div className="card divide-y divide-gray-100">{candidates.map(product => <button key={product.id} type="button" onClick={() => chooseProduct(product)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-gray-50"><span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">{product.image_path ? <img src={product.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-300" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-gray-800">{product.name}</span><span className="text-xs text-gray-400">{product.variants?.length || 0} 个尺码 · 销售中 done</span></span></button>)}</div></>
      : <><div className="card flex items-center gap-3 p-4"><span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100">{selectedProduct.image_path ? <img src={selectedProduct.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-300" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-gray-900">{selectedProduct.name}</p><ProductTagBadges product={selectedProduct} max={3} className="mt-1" /></div>{!initialItem && <button type="button" onClick={() => setSelectedProduct(null)} className="text-xs text-primary-600">更换</button>}</div><section className="card overflow-hidden"><div className="border-b border-gray-100 px-4 py-3"><h3 className="text-sm font-medium text-gray-800">{initialItem ? '各尺码当前汇总数量' : '各尺码本次新增数量'}</h3><p className="mt-0.5 text-xs text-gray-400">{initialItem ? '修改后将直接保存为新的汇总数量' : '可重复录入同一商品，系统会按尺码累加'}</p></div><div className="divide-y divide-gray-100">{(selectedProduct.variants || []).map(variant => <div key={variant.id} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-700">{variant.size}</p><p className="truncate font-mono text-xs text-gray-400">{variant.barcode}</p></div><input type="number" min="0" step="1" value={quantities[variant.id] ?? 0} onChange={event => setQuantities(current => ({ ...current, [variant.id]: event.target.value }))} className="input h-10 w-28 text-center font-semibold" aria-label={`${variant.size}${initialItem ? '汇总' : '新增'}待出货数量`} /></div>)}</div></section>{!initialItem && <section className="card p-4"><label className="block text-sm font-medium text-gray-800">本次录入备注 <span className="font-normal text-gray-400">（可选）</span></label><textarea value={note} onChange={event => setNote(event.target.value.slice(0, 500))} rows={3} className="input mt-2 resize-none py-2.5" placeholder="例如：9月第一批大货、预计周五发出" /><p className="mt-1 text-right text-xs text-gray-400">{note.length}/500</p></section>}</>}
    </div></main><footer className="shrink-0 border-t border-gray-200 bg-white px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}><div className="mx-auto flex max-w-2xl gap-3"><button type="button" onClick={onClose} className="btn-secondary flex-1">取消</button><button type="submit" disabled={!selectedProduct || saving} className="btn-primary flex-1">{saving ? <><LoaderCircle className="h-4 w-4 animate-spin" />保存中</> : initialItem ? '保存调整' : '合并本次录入'}</button></div></footer></form>
  </div>;
}

function FactoryTransferModal({ item, operator, onClose, onTransferred }) {
  const [quantities, setQuantities] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const activeVariants = item.variants.filter(variant => variant.quantity > 0);
  const total = Object.values(quantities).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const submit = async event => {
    event.preventDefault(); setSubmitting(true); setError('');
    try {
      const variants = activeVariants.map(variant => ({ id: variant.id, quantity: Number(quantities[variant.id]) || 0 })).filter(variant => variant.quantity > 0);
      await transferFactoryInventory(item.product_id, variants, operator);
      await onTransferred(`「${item.product.name}」已入库 ${total} ${item.product.unit || '个'}，销售库存已同步增加`);
    } catch (submitError) { setError(submitError.response?.data?.error || submitError.message || '入库失败'); }
    finally { setSubmitting(false); }
  };
  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => !submitting && onClose()}><form onSubmit={submit} className="w-full max-w-lg overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl" onClick={event => event.stopPropagation()}><div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5"><div><h3 className="font-semibold text-gray-900">待出货商品入库</h3><p className="text-xs text-gray-400">{item.product.name} · doing → done</p></div><button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button></div><div className="max-h-[60dvh] overflow-y-auto p-4">{error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}<div className="space-y-2">{activeVariants.map(variant => <div key={variant.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2.5"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-700">{variant.size}</p><p className="text-xs text-gray-400">待出货 {variant.quantity} · {variant.barcode}</p></div><input type="number" min="0" max={variant.quantity} step="1" placeholder="0" value={quantities[variant.id] ?? ''} onChange={event => setQuantities(current => ({ ...current, [variant.id]: Math.min(variant.quantity, Math.max(0, Number.parseInt(event.target.value, 10) || 0)) }))} className="input h-10 w-24 text-center font-semibold" /><button type="button" onClick={() => setQuantities(current => ({ ...current, [variant.id]: variant.quantity }))} className="text-xs text-primary-600">全部</button></div>)}</div></div><div className="flex items-center gap-3 border-t border-gray-100 px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}><p className="min-w-0 flex-1 text-xs text-gray-500">本次入库 <span className="font-semibold text-green-600">{total}</span> {item.product.unit || '个'}</p><button type="button" disabled={submitting} onClick={onClose} className="btn-secondary">取消</button><button type="submit" disabled={submitting || total <= 0} className="btn-success"><ArrowDownToLine className="h-4 w-4" />{submitting ? '入库中' : '确认入库'}</button></div></form></div>;
}
