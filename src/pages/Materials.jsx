import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, Check, ChevronDown, ChevronRight, CircleDollarSign, Factory, Layers3, Package, Pencil, Plus, Search, ShoppingCart, X } from 'lucide-react';
import { getMaterialRecords, getMaterials, getProducts, recordMaterialConsumption, recordMaterialPurchase, saveMaterial } from '../api/client';
import { useAuth } from '../AuthContext';
import useSyncRefresh from '../lib/useSyncRefresh';

const today = () => new Date().toISOString().slice(0, 10);
const formatQuantity = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const kindLabel = kind => kind === 'fabric' ? '面料' : '辅料';

export default function Materials() {
  const { user } = useAuth();
  const canManage = user?.role !== 'viewer';
  const [materials, setMaterials] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState(null);
  const [purchaseItem, setPurchaseItem] = useState(null);
  const [consumeItem, setConsumeItem] = useState(null);
  const [historyItem, setHistoryItem] = useState(null);
  const [message, setMessage] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const [materialRes, productRes] = await Promise.all([getMaterials(), getProducts()]);
      setMaterials(Array.isArray(materialRes.data) ? materialRes.data : []);
      setProducts(Array.isArray(productRes.data) ? productRes.data : []);
    } catch (error) {
      setMessage({ type: 'error', text: error.message || '面辅料数据读取失败' });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useSyncRefresh(loadData, ['inventory_materials', 'inventory_material_product_links', 'material_purchases', 'material_consumptions', 'products']);

  const visible = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return materials.filter(item => kind === 'all' || item.kind === kind).filter(item => !keyword || [
      item.name, item.model, item.color_code, item.contact_wechat,
      ...(item.links || []).flatMap(link => [link.product?.name, link.part]),
    ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [kind, materials, search]);

  const alerts = materials.filter(item => !item.alert_disabled && Number(item.current_stock) < Number(item.min_stock)).length;
  const finish = async text => { setMessage({ type: 'success', text }); await loadData(); };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-bold text-gray-900">面辅料管理</h1><p className="mt-0.5 text-sm text-gray-500">管理面料、辅料、采购入库和工厂裁数消耗</p></div>{canManage && <button type="button" onClick={() => setEditor({})} className="btn-primary"><Plus className="h-4 w-4" />新增面辅料</button>}</div>

    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat icon={Layers3} label="面辅料种类" value={materials.length} tone="blue" />
      <Stat icon={Boxes} label="面料" value={materials.filter(item => item.kind === 'fabric').length} tone="purple" />
      <Stat icon={Package} label="辅料" value={materials.filter(item => item.kind === 'accessory').length} tone="green" />
      <Stat icon={AlertTriangle} label="库存预警" value={alerts} tone={alerts ? 'red' : 'gray'} />
    </div>

    {message && <div className={`rounded-xl px-4 py-3 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{message.text}</div>}

    <div className="flex flex-col gap-3 sm:flex-row"><div className="flex rounded-xl bg-gray-100 p-1">{[['all', '全部'], ['fabric', '面料'], ['accessory', '辅料']].map(([value, label]) => <button key={value} type="button" onClick={() => setKind(value)} className={`rounded-lg px-4 py-2 text-sm font-medium ${kind === value ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-500'}`}>{label}</button>)}</div><div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={search} onChange={event => setSearch(event.target.value)} className="input pl-9" placeholder="搜索名称、型号、色号、微信或关联商品" /></div></div>

    {loading ? <div className="flex h-48 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" /></div> : visible.length === 0 ? <div className="card py-16 text-center text-sm text-gray-400"><Layers3 className="mx-auto mb-2 h-10 w-10 text-gray-300" />{search || kind !== 'all' ? '未找到匹配的面辅料' : '暂无面辅料，请先新增'}</div> : <div className="grid gap-4 lg:grid-cols-2">{visible.map(item => <MaterialCard key={item.id} item={item} canManage={canManage} onEdit={() => setEditor(item)} onPurchase={() => setPurchaseItem(item)} onConsume={() => setConsumeItem(item)} onHistory={() => setHistoryItem(item)} />)}</div>}

    {editor && <MaterialEditor initial={editor.id ? editor : null} products={products} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await finish(editor.id ? '面辅料信息已更新' : '面辅料已创建'); }} />}
    {purchaseItem && <PurchaseModal item={purchaseItem} onClose={() => setPurchaseItem(null)} onSaved={async () => { setPurchaseItem(null); await finish('购买记录已保存，库存已增加'); }} />}
    {consumeItem && <ConsumptionModal item={consumeItem} products={products} onClose={() => setConsumeItem(null)} onSaved={async () => { setConsumeItem(null); await finish('工厂裁数消耗已记录，库存已扣减'); }} />}
    {historyItem && <HistoryPanel item={historyItem} onClose={() => setHistoryItem(null)} />}
  </div>;
}

function Stat({ icon: Icon, label, value, tone }) {
  const colors = { blue: 'bg-blue-50 text-blue-600', purple: 'bg-purple-50 text-purple-600', green: 'bg-green-50 text-green-600', red: 'bg-red-50 text-red-600', gray: 'bg-gray-100 text-gray-500' };
  return <div className="card p-4"><span className={`mb-2 flex h-9 w-9 items-center justify-center rounded-lg ${colors[tone]}`}><Icon className="h-5 w-5" /></span><p className="text-2xl font-bold text-gray-900">{value}</p><p className="text-xs text-gray-500">{label}</p></div>;
}

function MaterialCard({ item, canManage, onEdit, onPurchase, onConsume, onHistory }) {
  const low = !item.alert_disabled && Number(item.current_stock) < Number(item.min_stock);
  return <section className={`card overflow-hidden ${low ? 'border-red-300 bg-red-50/30' : ''}`}>
    <div className="p-4"><div className="flex items-start gap-3"><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${item.kind === 'fabric' ? 'bg-purple-50 text-purple-600' : 'bg-green-50 text-green-600'}`}><Layers3 className="h-5 w-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-gray-900">{item.name}</h3><span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">{kindLabel(item.kind)}</span>{low && <span className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700"><AlertTriangle className="h-3 w-3" />低库存</span>}</div><p className="mt-1 text-xs text-gray-500">型号 {item.model || '—'} · 色号 {item.color_code || '—'} · 微信 {item.contact_wechat || '—'}</p></div>{canManage && <button type="button" onClick={onEdit} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><Pencil className="h-4 w-4" /></button>}</div>
      <div className="mt-4 flex items-end justify-between rounded-xl bg-white px-4 py-3"><div><p className={`text-2xl font-bold ${low ? 'text-red-600' : 'text-gray-900'}`}>{formatQuantity(item.current_stock)} <span className="text-sm font-medium">{item.unit}</span></p><p className="mt-0.5 text-[11px] text-gray-400">当前库存{item.alert_disabled ? ' · 已关闭预警' : ` · 预警值 ${formatQuantity(item.min_stock)} ${item.unit}`}</p></div>{low && <p className="text-xs font-medium text-red-600">请及时采购</p>}</div>
      <div className="mt-3"><p className="text-[11px] text-gray-400">关联商品与部位</p><div className="mt-1.5 flex flex-wrap gap-1.5">{item.links?.length ? item.links.map(link => <span key={link.id} className="rounded-lg bg-primary-50 px-2 py-1 text-xs text-primary-700">{link.product?.name || '已删除商品'}{link.part ? ` · ${link.part}` : ''}</span>) : <span className="text-xs text-gray-400">暂未关联商品</span>}</div></div>
    </div>
    <div className="grid grid-cols-3 border-t border-gray-100 bg-white">{canManage ? <><button type="button" onClick={onPurchase} className="flex items-center justify-center gap-1.5 border-r border-gray-100 py-3 text-xs font-medium text-green-700 hover:bg-green-50"><ShoppingCart className="h-4 w-4" />购买入库</button><button type="button" onClick={onConsume} className="flex items-center justify-center gap-1.5 border-r border-gray-100 py-3 text-xs font-medium text-orange-700 hover:bg-orange-50"><Factory className="h-4 w-4" />工厂裁数</button></> : <div className="col-span-2" />}<button type="button" onClick={onHistory} className="flex items-center justify-center gap-1 py-3 text-xs font-medium text-gray-600 hover:bg-gray-50">记录<ChevronRight className="h-4 w-4" /></button></div>
  </section>;
}

function Modal({ title, subtitle, onClose, children, width = 'max-w-xl' }) {
  useEffect(() => { const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = old; }; }, []);
  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 sm:items-center sm:p-4" onClick={onClose}><div className={`relative max-h-[90dvh] w-full ${width} overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl`} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} onClick={event => event.stopPropagation()}><div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-4 py-3"><div><h3 className="font-semibold text-gray-900">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p>}</div><button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button></div>{children}</div></div>;
}

function MaterialEditor({ initial, products, onClose, onSaved }) {
  const [form, setForm] = useState({ id: initial?.id, kind: initial?.kind || 'fabric', name: initial?.name || '', contact_wechat: initial?.contact_wechat || '', model: initial?.model || '', color_code: initial?.color_code || '', unit: initial?.unit || '米', initial_stock: 0, min_stock: initial?.min_stock || 0, alert_disabled: Boolean(initial?.alert_disabled), note: initial?.note || '', links: initial?.links?.map(link => ({ product_id: String(link.product_id), part: link.part || '' })) || [] });
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const changeKind = value => setForm(current => ({ ...current, kind: value, unit: value === 'fabric' ? '米' : (current.unit === '米' ? '个' : current.unit) }));
  const addLink = () => set('links', [...form.links, { product_id: '', part: '' }]);
  const updateLink = (index, key, value) => set('links', form.links.map((link, i) => i === index ? { ...link, [key]: value } : link));
  const submit = async event => { event.preventDefault(); if (!form.name.trim()) return setError('请填写名称'); if (form.links.some(link => !link.product_id)) return setError('请选择关联商品'); if (form.kind === 'accessory' && (!Number.isInteger(Number(form.initial_stock)) || !Number.isInteger(Number(form.min_stock)))) return setError('辅料的库存和预警值请填写整数'); setSaving(true); setError(''); try { await saveMaterial(form); await onSaved(); } catch (e) { setError(e.message || '保存失败'); } finally { setSaving(false); } };
  return <Modal title={initial ? '编辑面辅料' : '新增面辅料'} subtitle="可关联多个商品，并分别填写使用部位" onClose={onClose}><form onSubmit={submit} className="space-y-4 p-4"><div className="grid grid-cols-2 gap-2">{[['fabric', '面料'], ['accessory', '辅料']].map(([value, label]) => <button key={value} type="button" onClick={() => changeKind(value)} className={`rounded-xl border px-3 py-2.5 text-sm font-medium ${form.kind === value ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500'}`}>{label}</button>)}</div><Field label="名称 *"><input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder={form.kind === 'fabric' ? '例如：真丝提花面料' : '例如：盘扣'} /></Field><div className="grid grid-cols-2 gap-3"><Field label="型号"><input className="input" value={form.model} onChange={e => set('model', e.target.value)} /></Field><Field label="色号"><input className="input" value={form.color_code} onChange={e => set('color_code', e.target.value)} /></Field></div><Field label="联系微信"><input className="input" value={form.contact_wechat} onChange={e => set('contact_wechat', e.target.value)} placeholder="供应商微信" /></Field><div className="grid grid-cols-2 gap-3"><Field label="库存单位"><select className="input" value={form.unit} disabled={form.kind === 'fabric'} onChange={e => set('unit', e.target.value)}>{form.kind === 'fabric' ? <option>米</option> : <><option>个</option><option>件</option></>}</select></Field>{!initial ? <Field label="初始库存"><input type="number" min="0" step="0.01" className="input" value={form.initial_stock} onChange={e => set('initial_stock', e.target.value)} /></Field> : <Field label="当前库存"><div className="input bg-gray-50 text-gray-500">{formatQuantity(initial.current_stock)} {initial.unit}</div></Field>}</div><Field label="最低库存预警"><input type="number" min="0" step="0.01" className="input" value={form.min_stock} onChange={e => set('min_stock', e.target.value)} /></Field><label className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-3"><span><span className="block text-sm font-medium text-gray-700">关闭库存预警</span><span className="text-xs text-gray-400">开启后该项库存不足时不再提醒</span></span><input type="checkbox" checked={form.alert_disabled} onChange={e => set('alert_disabled', e.target.checked)} /></label><div><div className="mb-2 flex items-center justify-between"><label className="text-sm font-medium text-gray-700">关联商品与使用部位</label><button type="button" onClick={addLink} className="text-xs font-medium text-primary-600">+ 添加关联</button></div><div className="space-y-2">{form.links.map((link, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2"><ProductSearchSelect products={products} value={link.product_id} autoFocus={!link.product_id && index === form.links.length - 1} onChange={value => updateLink(index, 'product_id', value)} /><input className="input" value={link.part} onChange={e => updateLink(index, 'part', e.target.value)} placeholder="关联部位，如袖口" /><button type="button" onClick={() => set('links', form.links.filter((_, i) => i !== index))} className="rounded-lg px-2 text-gray-400 hover:bg-red-50 hover:text-red-500"><X className="h-4 w-4" /></button></div>)}</div></div><Field label="备注"><textarea className="input min-h-20" value={form.note} onChange={e => set('note', e.target.value)} maxLength={500} /></Field>{error && <p className="text-sm text-red-600">{error}</p>}<button type="submit" disabled={saving} className="btn-primary w-full">{saving ? '保存中…' : '保存面辅料'}</button></form></Modal>;
}

function PurchaseModal({ item, onClose, onSaved }) {
  const [form, setForm] = useState({ quantity: '', amount: '', purchase_date: today(), note: '' }); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const submit = async event => { event.preventDefault(); if (!(Number(form.quantity) > 0)) return setError('购买数量必须大于0'); if (item.kind === 'accessory' && !Number.isInteger(Number(form.quantity))) return setError('辅料购买数量请填写整数'); setSaving(true); setError(''); try { await recordMaterialPurchase({ ...form, material_id: item.id }); await onSaved(); } catch (e) { setError(e.message || '保存失败'); } finally { setSaving(false); } };
  return <Modal title="购买入库" subtitle={`${item.name} · 当前 ${formatQuantity(item.current_stock)} ${item.unit}`} onClose={onClose}><form onSubmit={submit} className="space-y-4 p-4"><div className="grid grid-cols-2 gap-3"><Field label={`购买数量（${item.unit}）*`}><input autoFocus type="number" min="0.01" step="0.01" className="input" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></Field><Field label="花费（元）"><input type="number" min="0" step="0.01" className="input" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></Field></div><Field label="购买日期"><input type="date" className="input" value={form.purchase_date} onChange={e => setForm({ ...form, purchase_date: e.target.value })} /></Field><Field label="备注"><textarea className="input min-h-20" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>{error && <p className="text-sm text-red-600">{error}</p>}<button disabled={saving} className="btn-success w-full"><ShoppingCart className="h-4 w-4" />{saving ? '提交中…' : `确认入库${form.quantity ? ` ${form.quantity} ${item.unit}` : ''}`}</button></form></Modal>;
}

function ConsumptionModal({ item, products, onClose, onSaved }) {
  const linkedIds = new Set((item.links || []).map(link => String(link.product_id))); const selectable = products.filter(product => linkedIds.has(String(product.id)));
  const [form, setForm] = useState({ product_id: selectable[0]?.id || '', cut_quantity: '', quantity: '', consumed_at: today(), note: '' }); const [confirming, setConfirming] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const request = event => { event.preventDefault(); if (!(Number(form.quantity) > 0)) return setError('请填写大于0的实际消耗数量'); if (item.kind === 'accessory' && !Number.isInteger(Number(form.quantity))) return setError('辅料消耗数量请填写整数'); if (Number(form.quantity) > Number(item.current_stock)) return setError(`库存不足，当前仅 ${formatQuantity(item.current_stock)} ${item.unit}`); setError(''); setConfirming(true); };
  const submit = async () => { setSaving(true); try { await recordMaterialConsumption({ ...form, material_id: item.id }); await onSaved(); } catch (e) { setError(e.message || '扣减失败'); setConfirming(false); } finally { setSaving(false); } };
  return <Modal title="录入工厂裁数" subtitle={`${item.name} · 当前库存 ${formatQuantity(item.current_stock)} ${item.unit}`} onClose={onClose}><form onSubmit={request} className="space-y-4 p-4"><div className="flex gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-orange-800"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="text-sm font-semibold">请重点核对实际消耗数量</p><p className="mt-1 text-xs leading-5">确认后将直接从面辅料库存扣减，不能超过当前库存。</p></div></div><Field label="制作商品">{selectable.length ? <select className="input" value={form.product_id} onChange={e => setForm({ ...form, product_id: e.target.value })}><option value="">不指定商品</option>{selectable.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select> : <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-400">该面辅料尚未关联商品</div>}</Field><div className="grid grid-cols-2 gap-3"><Field label="工厂裁数（件）"><input type="number" min="0" step="1" className="input" value={form.cut_quantity} onChange={e => setForm({ ...form, cut_quantity: e.target.value })} /></Field><Field label={`实际消耗（${item.unit}）*`}><input type="number" min="0.01" max={item.current_stock} step="0.01" className="input border-orange-300 bg-orange-50 text-lg font-bold text-orange-700" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></Field></div><Field label="裁数日期"><input type="date" className="input" value={form.consumed_at} onChange={e => setForm({ ...form, consumed_at: e.target.value })} /></Field><Field label="备注"><textarea className="input min-h-20" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>{error && <p className="text-sm text-red-600">{error}</p>}<button className="w-full rounded-xl bg-orange-600 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-700"><Factory className="mr-2 inline h-4 w-4" />核对并扣减库存</button></form>{confirming && <div className="absolute inset-0 z-20 flex items-end bg-black/40 sm:items-center sm:justify-center sm:p-4"><div className="w-full rounded-t-2xl bg-white p-5 sm:max-w-sm sm:rounded-2xl"><AlertTriangle className="mb-3 h-8 w-8 text-orange-500" /><h4 className="font-semibold text-gray-900">再次确认裁数消耗</h4><p className="mt-2 text-sm text-gray-600">{item.name} 将扣减 <strong className="text-orange-700">{form.quantity} {item.unit}</strong>，扣减后预计剩余 {formatQuantity(Number(item.current_stock) - Number(form.quantity))} {item.unit}。</p><div className="mt-5 flex gap-3"><button type="button" onClick={() => setConfirming(false)} className="btn-secondary flex-1">返回检查</button><button type="button" disabled={saving} onClick={submit} className="flex-1 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white">{saving ? '扣减中…' : '确认扣减'}</button></div></div></div>}</Modal>;
}

function HistoryPanel({ item, onClose }) {
  const [records, setRecords] = useState({ purchases: [], consumptions: [] }); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { try { const res = await getMaterialRecords(item.id); setRecords(res.data); } finally { setLoading(false); } }, [item.id]);
  useEffect(() => { load(); }, [load]); useSyncRefresh(load, ['material_purchases', 'material_consumptions']);
  const list = [...records.purchases.map(record => ({ ...record, type: 'purchase', date: record.purchase_date })), ...records.consumptions.map(record => ({ ...record, type: 'consume', date: record.consumed_at }))].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return <Modal title="库存记录" subtitle={`${item.name} · 当前 ${formatQuantity(item.current_stock)} ${item.unit}`} onClose={onClose}>{loading ? <div className="p-12 text-center text-sm text-gray-400">加载中…</div> : list.length ? <div className="divide-y divide-gray-100">{list.map(record => <div key={`${record.type}_${record.id}`} className="flex gap-3 px-4 py-3"><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${record.type === 'purchase' ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600'}`}>{record.type === 'purchase' ? <CircleDollarSign className="h-4 w-4" /> : <Factory className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between"><p className="text-sm font-medium text-gray-800">{record.type === 'purchase' ? '购买入库' : '工厂裁数消耗'}</p><span className={`font-semibold ${record.type === 'purchase' ? 'text-green-600' : 'text-orange-600'}`}>{record.type === 'purchase' ? '+' : '−'}{formatQuantity(record.quantity)} {item.unit}</span></div><p className="mt-1 text-xs text-gray-400">{record.date}{record.type === 'purchase' ? ` · 花费 ¥${formatQuantity(record.amount)}` : `${record.product?.name ? ` · ${record.product.name}` : ''}${record.cut_quantity ? ` · 裁数 ${record.cut_quantity} 件` : ''}`}{record.user_name ? ` · ${record.user_name}` : ''}</p>{record.note && <p className="mt-1.5 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs text-gray-500">{record.note}</p>}</div></div>)}</div> : <div className="p-12 text-center text-sm text-gray-400">暂无购买或消耗记录</div>}</Modal>;
}

function ProductSearchSelect({ products, value, onChange, autoFocus = false }) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = products.find(product => String(product.id) === String(value));
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  const results = products.filter(product => !keyword || [
    product.name, product.category, product.sub_tags,
    ...(product.variants || []).flatMap(variant => [variant.size, variant.barcode]),
  ].some(item => String(item || '').toLocaleLowerCase('zh-CN').includes(keyword))).slice(0, 50);

  useEffect(() => {
    if (!autoFocus || value) return;
    inputRef.current?.focus();
    setOpen(true);
  }, [autoFocus, value]);

  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = product => {
    onChange(String(product.id));
    setQuery('');
    setOpen(false);
  };

  return <div ref={rootRef} className="relative min-w-0">
    <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-gray-400" />
    <input
      ref={inputRef}
      type="search"
      className="input pr-8 pl-9"
      value={open ? query : (selected?.name || '')}
      placeholder="搜索并选择商品"
      onFocus={() => { setQuery(''); setOpen(true); }}
      onChange={event => { setQuery(event.target.value); setOpen(true); }}
      aria-expanded={open}
      aria-label="搜索关联商品"
    />
    <ChevronDown className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
    {open && <div className="absolute z-40 mt-1 max-h-56 w-full min-w-60 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-xl">
      {results.length ? results.map(product => <button key={product.id} type="button" onClick={() => choose(product)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 ${String(product.id) === String(value) ? 'bg-primary-50 text-primary-700' : 'text-gray-700'}`}>
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{product.name}</span><span className="block truncate text-[11px] text-gray-400">{product.category || '未分类'}{product.sub_tags ? ` · ${product.sub_tags}` : ''}</span></span>
        {String(product.id) === String(value) && <Check className="h-4 w-4 shrink-0" />}
      </button>) : <p className="px-3 py-6 text-center text-sm text-gray-400">未找到匹配商品</p>}
    </div>}
  </div>;
}

function Field({ label, children }) { return <label className="block"><span className="mb-1.5 block text-sm font-medium text-gray-700">{label}</span>{children}</label>; }
