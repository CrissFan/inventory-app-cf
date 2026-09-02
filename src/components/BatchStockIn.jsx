import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, Download, FileSpreadsheet, LoaderCircle, Package, Search, ShieldCheck, Upload, X } from 'lucide-react';
import { batchStockIn, getProducts } from '../api/client';
import { useAuth } from '../AuthContext';
import useSyncRefresh from '../lib/useSyncRefresh';
import ReasonSelector from './ReasonSelector';
import ProductTagBadges from './ProductTagBadges';

const STOCK_IN_REASONS = [
  { value: '退换货入库', description: '退回或换货商品重新入库' },
  { value: '大货入库', description: '采购或批量到货入库' },
];

const rowKey = (productId, variantId) => `${productId}::${variantId}`;
const normalizeHeader = value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const headerAliases = {
  name: ['商品名称', '名称', 'productname'],
  size: ['商品尺码', '尺码', '规格', 'size'],
  barcode: ['商品尺码条形码', '尺码条形码', '条形码', '条码', 'barcode'],
  quantity: ['入库数量', '数量', 'quantity'],
};

function findColumn(headers, aliases) {
  const values = new Set(aliases.map(normalizeHeader));
  return headers.findIndex(header => values.has(normalizeHeader(header)));
}

export default function BatchStockIn({ onClose, onCompleted, product = null }) {
  const { user } = useAuth();
  const fileInputRef = useRef(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [quantities, setQuantities] = useState({});
  const [reason, setReason] = useState('大货入库');
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const [showConfirm, setShowConfirm] = useState(false);

  const loadProducts = useCallback(async () => {
    try {
      const response = await getProducts();
      setProducts(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || error.message || '商品读取失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useSyncRefresh(loadProducts, ['products']);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const scopedProducts = useMemo(() => {
    if (!product) return products;
    return products.filter(item => String(item.id) === String(product.id));
  }, [product, products]);

  const rows = useMemo(() => scopedProducts.flatMap(item => (item.variants || []).map(variant => ({
    key: rowKey(item.id, variant.id),
    product_id: item.id,
    variant_id: variant.id,
    product_name: item.name,
    size: variant.size || '',
    barcode: variant.barcode || '',
    current_stock: Number(variant.current_stock) || 0,
    unit: item.unit || '个',
    image_path: item.image_path || '',
    category: item.category || '',
    sub_tags: item.sub_tags || '',
  }))), [scopedProducts]);

  const filteredRows = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (!keyword) return rows;
    return rows.filter(row => [row.product_name, row.size, row.barcode]
      .some(value => String(value).toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [rows, search]);

  const selectedRows = useMemo(() => rows.filter(row => selected.has(row.key)), [rows, selected]);
  const totalQuantity = selectedRows.reduce((sum, row) => sum + (Number(quantities[row.key]) || 0), 0);
  const allVisibleSelected = filteredRows.length > 0 && filteredRows.every(row => selected.has(row.key));

  const toggleRow = row => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
      return next;
    });
    setMessage(null);
  };

  const updateQuantity = (row, value) => {
    const clean = value === '' ? '' : String(Math.max(0, Number.parseInt(value, 10) || 0));
    setQuantities(current => ({ ...current, [row.key]: clean }));
    if (Number(clean) > 0) setSelected(current => new Set(current).add(row.key));
    setMessage(null);
  };

  const toggleAllVisible = () => {
    setSelected(current => {
      const next = new Set(current);
      filteredRows.forEach(row => { if (allVisibleSelected) next.delete(row.key); else next.add(row.key); });
      return next;
    });
  };

  const exportSheet = async () => {
    const exportRows = selectedRows.length ? selectedRows : rows;
    if (!exportRows.length) return;
    const XLSX = await import('xlsx');
    const data = exportRows.map(row => ({
      商品名称: row.product_name,
      商品尺码: row.size,
      商品尺码条形码: row.barcode,
      入库数量: quantities[row.key] || '',
    }));
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(data, { header: ['商品名称', '商品尺码', '商品尺码条形码', '入库数量'] });
    sheet['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 24 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(workbook, sheet, '批量入库');
    XLSX.writeFile(workbook, `批量入库表格_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const importSheet = async file => {
    if (!file) return;
    setParsing(true);
    setImportErrors([]);
    setMessage(null);
    try {
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['xlsx', 'xls', 'csv'].includes(extension)) throw new Error('仅支持 .xlsx、.xls 或 .csv 文件');
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('文件中没有可读取的工作表');
      const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
      if (values.length < 2) throw new Error('文件中没有入库数据');
      const columns = Object.fromEntries(Object.entries(headerAliases).map(([field, aliases]) => [field, findColumn(values[0], aliases)]));
      const labels = { name: '商品名称', size: '商品尺码', barcode: '商品尺码条形码', quantity: '入库数量' };
      const missing = Object.entries(columns).filter(([, index]) => index < 0).map(([field]) => labels[field]);
      if (missing.length) throw new Error(`缺少列：${missing.join('、')}`);

      const byBarcode = new Map(rows.map(row => [String(row.barcode).trim(), row]));
      const nextSelected = new Set();
      const nextQuantities = {};
      const seen = new Set();
      const errors = [];
      values.slice(1).forEach((valuesRow, index) => {
        const line = index + 2;
        const read = field => String(valuesRow[columns[field]] ?? '').trim();
        const name = read('name');
        const size = read('size');
        const barcode = read('barcode');
        const quantityText = read('quantity');
        if (![name, size, barcode, quantityText].some(Boolean) || quantityText === '') return;
        const quantity = Number(quantityText);
        if (!Number.isInteger(quantity) || quantity <= 0) { errors.push(`第 ${line} 行：入库数量必须是大于0的整数`); return; }
        if (!barcode) { errors.push(`第 ${line} 行：商品尺码条形码不能为空`); return; }
        const matched = byBarcode.get(barcode);
        if (!matched) { errors.push(`第 ${line} 行：未找到条形码「${barcode}」对应的商品尺码`); return; }
        if (seen.has(barcode)) { errors.push(`第 ${line} 行：条形码「${barcode}」在文件中重复`); return; }
        if (name !== matched.product_name || size !== matched.size) {
          errors.push(`第 ${line} 行：条形码「${barcode}」对应的是「${matched.product_name} / ${matched.size}」`);
          return;
        }
        seen.add(barcode);
        nextSelected.add(matched.key);
        nextQuantities[matched.key] = String(quantity);
      });
      setSelected(nextSelected);
      setQuantities(nextQuantities);
      setImportErrors(errors);
      if (!nextSelected.size) throw new Error(errors.length ? '文件中没有校验通过的入库条目' : '请在“入库数量”列填写需要入库的数量');
      setMessage({ type: errors.length ? 'warning' : 'success', text: `已导入 ${nextSelected.size} 个商品尺码，请确认后提交${errors.length ? `；另有 ${errors.length} 条需要修正` : ''}` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message || '表格解析失败' });
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const requestSubmit = () => {
    if (!selectedRows.length) { setMessage({ type: 'error', text: '请至少选择一个商品尺码' }); return; }
    const invalid = selectedRows.filter(row => !Number.isInteger(Number(quantities[row.key])) || Number(quantities[row.key]) <= 0);
    if (invalid.length) { setMessage({ type: 'error', text: `请填写所选商品尺码的入库数量（还有 ${invalid.length} 项未填写）` }); return; }
    if (!reason) { setMessage({ type: 'error', text: '请选择入库原因' }); return; }
    setMessage(null);
    setShowConfirm(true);
  };

  const submit = async () => {
    setShowConfirm(false);
    setSubmitting(true);
    setMessage(null);
    try {
      await batchStockIn(selectedRows.map(row => ({
        product_id: row.product_id,
        variant_id: row.variant_id,
        quantity: Number(quantities[row.key]),
        reason,
        operator: user?.display_name || '未知用户',
      })));
      setMessage({ type: 'success', text: `批量入库成功：${selectedRows.length} 个商品尺码，共 ${totalQuantity} 件` });
      setSelected(new Set());
      setQuantities({});
      setImportErrors([]);
      await loadProducts();
      onCompleted?.();
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || error.message || '批量入库失败' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-gray-50">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 bg-white px-4 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
        <button type="button" onClick={onClose} className="-ml-1 rounded-lg p-1 hover:bg-gray-100"><ArrowLeft className="h-5 w-5 text-gray-600" /></button>
        <div className="min-w-0 flex-1"><h2 className="truncate font-bold text-gray-900">{product ? `${product.name} · 批量入库` : '批量入库'}</h2><p className="truncate text-xs text-gray-400">{product ? '一次录入该商品的多个尺码库存' : '选择商品尺码或上传入库表格'}</p></div>
        {!product && <><input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={event => importSheet(event.target.files?.[0])} />
          <button type="button" disabled={parsing || submitting} onClick={() => fileInputRef.current?.click()} className="btn-secondary px-3 py-2 text-xs">
            {parsing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}上传表格
          </button>
          <button type="button" disabled={!rows.length || submitting} onClick={exportSheet} className="btn-secondary px-3 py-2 text-xs"><Download className="h-4 w-4" />导出表格</button></>}
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-6xl space-y-4 pb-32">
          <section className="card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {!product && <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input className="input pl-9" placeholder="搜索商品名称、尺码或条形码" value={search} onChange={event => setSearch(event.target.value)} />
              </div>}
              {product && <div className="flex min-w-0 flex-1 items-center gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">{product.image_path ? <img src={product.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-gray-400" />}</span><div className="min-w-0"><p className="truncate text-sm font-medium text-gray-900">{product.name}</p><p className="mt-0.5 text-xs text-gray-400">共 {rows.length} 个尺码 · 当前总库存 {product.current_stock || 0}</p></div></div>}
              <div className="text-xs text-gray-500">已选 <span className="font-semibold text-primary-600">{selectedRows.length}</span> 项 · 入库 <span className="font-semibold text-green-600">{totalQuantity}</span> 件</div>
            </div>
            {!product && <p className="mt-2 text-xs leading-5 text-gray-400">“导出表格”默认导出全部商品尺码；有勾选时仅导出所选项。填写“入库数量”后，可上传同一格式的 Excel 或 CSV 文件。</p>}
          </section>

          {message && <div className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-600' : message.type === 'warning' ? 'bg-orange-50 text-orange-700' : 'bg-green-50 text-green-700'}`}>
            {message.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}{message.text}
          </div>}
          {importErrors.length > 0 && <details className="card border-red-100 p-4"><summary className="cursor-pointer text-sm font-medium text-red-600">查看 {importErrors.length} 条表格错误</summary><div className="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs text-red-500">{importErrors.map((error, index) => <p key={`${error}_${index}`}>{error}</p>)}</div></details>}

          <section className="card overflow-hidden">
            {loading ? <div className="flex h-48 items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-primary-500" /></div> : filteredRows.length === 0 ? <div className="p-12 text-center text-sm text-gray-400"><Package className="mx-auto mb-2 h-9 w-9 text-gray-300" />{search ? '未找到匹配的商品尺码' : '暂无可入库商品'}</div> : product ? <div>
              <label className="flex cursor-pointer items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-medium text-gray-600"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />选择全部尺码</label>
              <div className="divide-y divide-gray-100">{filteredRows.map(row => {
                const checked = selected.has(row.key);
                return <div key={row.key} className={`flex items-center gap-3 px-4 py-3 ${checked ? 'bg-green-50/60' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleRow(row)} aria-label={`选择${row.size}`} />
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="font-medium text-gray-900">{row.size || '默认规格'}</p><span className="text-xs text-gray-400">库存 {row.current_stock} {row.unit}</span></div><p className="mt-1 truncate font-mono text-[11px] text-gray-400">{row.barcode || '无条形码'}</p></div>
                  <div className="flex items-center gap-1.5"><span className="text-xs text-gray-400">入库</span><input type="number" min="1" step="1" inputMode="numeric" className="input h-10 w-24 text-center font-semibold" placeholder="数量" value={quantities[row.key] ?? ''} onChange={event => updateQuantity(row, event.target.value)} /></div>
                </div>;
              })}</div>
            </div> : <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500"><tr>
                  <th className="w-12 px-4 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="选择当前搜索结果" /></th>
                  <th className="px-3 py-3 font-medium">商品名称</th><th className="px-3 py-3 font-medium">商品尺码</th><th className="px-3 py-3 font-medium">商品尺码条形码</th><th className="px-3 py-3 font-medium">当前库存</th><th className="w-36 px-4 py-3 font-medium">入库数量</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-100">{filteredRows.map(row => {
                  const checked = selected.has(row.key);
                  return <tr key={row.key} className={checked ? 'bg-green-50/50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-3"><input type="checkbox" checked={checked} onChange={() => toggleRow(row)} aria-label={`选择${row.product_name}${row.size}`} /></td>
                    <td className="px-3 py-3"><div className="flex items-start gap-2"><span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">{row.image_path ? <img src={row.image_path} alt="" className="h-full w-full object-cover" /> : <Package className="h-4 w-4 text-gray-400" />}</span><div className="min-w-0"><p className="font-medium text-gray-800">{row.product_name}</p><ProductTagBadges product={row} max={2} className="mt-1" /></div></div></td>
                    <td className="px-3 py-3 text-gray-600">{row.size}</td><td className="px-3 py-3 font-mono text-xs text-gray-500">{row.barcode}</td><td className="px-3 py-3 text-gray-600">{row.current_stock} {row.unit}</td>
                    <td className="px-4 py-2"><input type="number" min="1" step="1" className="input h-9 w-24 text-center font-semibold" placeholder="填写数量" value={quantities[row.key] ?? ''} onChange={event => updateQuantity(row, event.target.value)} /></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
          </section>

          <section className="card p-4"><ReasonSelector label="本批入库原因" value={reason} onChange={setReason} options={STOCK_IN_REASONS} tone="green" /></section>
        </div>
      </main>

      <footer className="shrink-0 border-t border-gray-200 bg-white px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div className="mx-auto flex max-w-6xl items-center gap-3"><div className="min-w-0 flex-1 text-xs text-gray-500"><p>已选 {selectedRows.length} 个商品尺码</p><p className="mt-0.5 truncate">合计入库 {totalQuantity} 件 · {reason || '未选择原因'}</p></div><button type="button" onClick={requestSubmit} disabled={submitting || !selectedRows.length} className="btn-success min-w-36 px-5">{submitting ? <><LoaderCircle className="h-4 w-4 animate-spin" />提交中...</> : <><FileSpreadsheet className="h-4 w-4" />确认批量入库</>}</button></div>
      </footer>

      {showConfirm && <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/45 sm:items-center sm:p-4" onClick={() => setShowConfirm(false)}>
        <div className="flex max-h-[82dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5"><div className="flex items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-green-50"><ShieldCheck className="h-5 w-5 text-green-600" /></span><div><h3 className="font-semibold text-gray-900">确认批量入库</h3><p className="text-xs text-gray-400">提交后将立即增加对应尺码库存</p></div></div><button type="button" onClick={() => setShowConfirm(false)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button></div>
          <div className="flex-1 overflow-y-auto px-4 py-3"><div className="mb-3 rounded-xl bg-green-50 px-4 py-3"><div className="flex justify-between text-sm"><span className="text-green-700">{product ? product.name : `${new Set(selectedRows.map(row => row.product_id)).size} 个商品`}</span><span className="font-bold text-green-700">共 {totalQuantity} 件</span></div><p className="mt-1 text-xs text-green-600">入库原因：{reason} · 操作人：{user?.display_name || '未知用户'}</p></div><div className="divide-y divide-gray-100 rounded-xl border border-gray-100">{selectedRows.map(row => <div key={row.key} className="flex items-center gap-3 px-3 py-2.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-800">{row.product_name} · {row.size}</p><p className="mt-0.5 text-xs text-gray-400">当前库存 {row.current_stock} {row.unit}{row.barcode ? ` · ${row.barcode}` : ''}</p></div><span className="shrink-0 text-base font-bold text-green-600">+{quantities[row.key]}</span></div>)}</div></div>
          <div className="flex gap-3 border-t border-gray-100 px-4 py-3"><button type="button" onClick={() => setShowConfirm(false)} className="btn-secondary flex-1">返回修改</button><button type="button" onClick={submit} disabled={submitting} className="btn-success flex-1">确认入库 {totalQuantity}</button></div>
        </div>
      </div>}
    </div>
  );
}
