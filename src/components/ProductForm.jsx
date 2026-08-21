import { useState, useEffect, useRef } from 'react';
import { ScanLine, Save, ChevronDown, Trash2, ArrowLeft, Plus, X, BellOff } from 'lucide-react';
import ImageUpload from './ImageUpload';
import BarcodeScanner from './BarcodeScanner';
import { createProduct, updateProduct, deleteProduct, getTags } from '../api/client';

const variantId = () => globalThis.crypto?.randomUUID?.() || `variant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const emptyVariant = () => ({ id: variantId(), size: '', barcode: '', current_stock: 0, min_stock: 0 });

export default function ProductForm({ product, onClose, onSaved, onDelete }) {
  const [form, setForm] = useState({
    variants: [emptyVariant()],
    name: '',
    description: '',
    category: '',
    sub_tags: '',
    image_path: '',
    min_stock: 0,
    stock_alert_disabled: false,
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [scanningVariantId, setScanningVariantId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [warningEditors, setWarningEditors] = useState(new Set());

  // Tags state
  const [tags, setTags] = useState([]);
  const [tagDropdown, setTagDropdown] = useState(false);
  const dropdownRef = useRef(null);

  // Load tags on mount
  useEffect(() => {
    loadTags();
  }, []);

  // Prevent body scroll when modal is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  useEffect(() => {
    if (product) {
      setForm({
        variants: Array.isArray(product.variants) && product.variants.length
          ? product.variants.map(variant => ({ ...variant, min_stock: Number(variant.min_stock ?? product.min_stock) || 0 }))
          : [{ id: `legacy_${product.id}`, size: '默认规格', barcode: product.barcode || '', current_stock: product.current_stock || 0, min_stock: product.min_stock || 0 }],
        name: product.name || '',
        description: product.description || '',
        category: product.category || '',
        sub_tags: product.sub_tags || '',
        image_path: product.image_path || '',
        min_stock: product.min_stock || 0,
        stock_alert_disabled: product.stock_alert_disabled === true || product.stock_alert_disabled === 1 || String(product.stock_alert_disabled).trim().toLowerCase() === 'true',
      });
    }
  }, [product]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setTagDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const loadTags = async () => {
    try {
      const res = await getTags();
      setTags(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  };

  const set = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const setVariant = (id, key, value) => {
    setForm(prev => ({
      ...prev,
      variants: prev.variants.map(variant => variant.id === id ? { ...variant, [key]: value } : variant),
    }));
  };

  const removeVariant = (variant) => {
    if ((variant.current_stock || 0) > 0) {
      setError(`尺码「${variant.size || '未命名'}」仍有库存，不能删除`);
      return;
    }
    setForm(prev => ({ ...prev, variants: prev.variants.filter(item => item.id !== variant.id) }));
    setWarningEditors(current => {
      const next = new Set(current);
      next.delete(variant.id);
      return next;
    });
  };

  const openWarningEditor = (id) => setWarningEditors(current => new Set(current).add(id));
  const clearWarning = (id) => {
    setVariant(id, 'min_stock', 0);
    setWarningEditors(current => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('商品名称不能为空');
      return;
    }
    setError('');
    if (!form.variants.length) {
      setError('请至少添加一个尺码');
      return;
    }
    const normalizedVariants = form.variants.map(variant => ({
      ...variant,
      size: variant.size.trim(),
      barcode: variant.barcode.trim(),
      current_stock: Number(variant.current_stock) || 0,
      min_stock: Math.max(0, Number(variant.min_stock) || 0),
    }));
    if (normalizedVariants.some(variant => !variant.size || !variant.barcode)) {
      setError('每个尺码都必须填写尺码名称和条形码');
      return;
    }
    const sizes = normalizedVariants.map(variant => variant.size.toLowerCase());
    const barcodes = normalizedVariants.map(variant => variant.barcode);
    if (new Set(sizes).size !== sizes.length) {
      setError('同一商品不能添加重复尺码');
      return;
    }
    if (new Set(barcodes).size !== barcodes.length) {
      setError('同一商品不能使用重复条形码');
      return;
    }
    setSaving(true);
    try {
      if (product) {
        const res = await updateProduct(product.id, { ...form, min_stock: normalizedVariants.reduce((sum, v) => sum + v.min_stock, 0), variants: normalizedVariants });
        onSaved(res.data);
      } else {
        const res = await createProduct({ ...form, min_stock: normalizedVariants.reduce((sum, v) => sum + v.min_stock, 0), variants: normalizedVariants });
        onSaved(res.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!product) return;
    setDeleting(true);
    try {
      await deleteProduct(product.id);
      onDelete?.();
    } catch (err) {
      setError(err.response?.data?.error || '删除失败');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleScan = (code) => {
    if (scanningVariantId) setVariant(scanningVariantId, 'barcode', code.trim());
    setShowScanner(false);
    setScanningVariantId(null);
  };

  // 标签层级计算
  const topTags = tags.filter(t => !t.parent_id);
  const firstLevelId = tags.find(t => !t.parent_id && t.name === form.category)?.id;
  const secondLevelTags = tags.filter(t => t.parent_id === firstLevelId);
  const selectedSubTags = (form.sub_tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const toggleSubTag = (name) => {
    const next = selectedSubTags.includes(name)
      ? selectedSubTags.filter(n => n !== name)
      : [...selectedSubTags, name];
    set('sub_tags', next.join(','));
  };

  if (showScanner) {
    return <BarcodeScanner onScan={handleScan} onClose={() => { setShowScanner(false); setScanningVariantId(null); }} />;
  }

  return (
    <div className="fixed inset-0 z-[60] bg-gray-50 flex flex-col">
      {/* Header - outside form */}
      <div
        className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 flex-shrink-0"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <button onClick={onClose} className="p-1 -ml-1 hover:bg-gray-100 rounded-lg flex items-center justify-center">
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>
        <h2 className="font-bold text-gray-900 flex-1">{product ? '编辑商品' : '新建商品'}</h2>
      </div>

      {/* Form wraps scrollable area + bottom actions */}
      <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
        {/* 校验提示：置顶展示（创建页校验如「条形码为必填项」落在此处） */}
        {error && (
          <div className="px-4 pt-3 flex-shrink-0">
            <div className="max-w-lg mx-auto px-3.5 py-2.5 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>
          </div>
        )}

        {/* Scrollable form fields */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="max-w-lg mx-auto space-y-4 pb-4">
          {/* Image */}
          <ImageUpload value={form.image_path} onChange={path => set('image_path', path)} />

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">商品名称 <span className="text-red-500">*</span></label>
            <input
              className="input"
              placeholder="请输入商品名称"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

          {/* 尺码规格 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium text-gray-700">尺码与条形码 <span className="text-red-500">*</span></label>
              <button
                type="button"
                onClick={() => setForm(prev => ({ ...prev, variants: [...prev.variants, emptyVariant()] }))}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-primary-600 hover:bg-primary-50"
              >
                <Plus className="h-3.5 w-3.5" />添加尺码
              </button>
            </div>
            <div className="space-y-2.5">
              {form.variants.map((variant, index) => (
                <div key={variant.id} className="rounded-xl border border-gray-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500">尺码 {index + 1}</span>
                    {form.variants.length > 1 && (
                      <button type="button" onClick={() => removeVariant(variant)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500" title="删除尺码">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_40px] gap-2">
                    <input
                      className="input px-3"
                      placeholder="如 S、M"
                      value={variant.size}
                      onChange={event => setVariant(variant.id, 'size', event.target.value)}
                      maxLength={20}
                    />
                    <input
                      className="input px-3 font-mono"
                      placeholder="对应条形码"
                      value={variant.barcode}
                      onChange={event => setVariant(variant.id, 'barcode', event.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => { setScanningVariantId(variant.id); setShowScanner(true); }}
                      className="flex items-center justify-center rounded-lg border border-gray-300 text-primary-600 hover:bg-primary-50"
                      title="扫描该尺码条形码"
                    >
                      <ScanLine className="h-4 w-4" />
                    </button>
                  </div>
                  {warningEditors.has(variant.id) || Number(variant.min_stock) > 0 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                      <label className="shrink-0 text-xs text-gray-500">最低库存预警 <span className="text-gray-300">（可选）</span></label>
                      <input
                        type="number"
                        min="0"
                        className="h-8 w-20 rounded-lg border border-gray-300 px-2 text-center text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                        value={variant.min_stock || 0}
                        onChange={event => setVariant(variant.id, 'min_stock', Math.max(0, parseInt(event.target.value) || 0))}
                      />
                      <button type="button" onClick={() => clearWarning(variant.id)} className="text-xs text-gray-400 hover:text-red-500">{Number(variant.min_stock) > 0 ? '恢复默认 0' : '收起'}</button>
                      {product && <span className="ml-auto text-xs text-gray-400">当前库存：{variant.current_stock || 0} {product.unit || '个'}</span>}
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center justify-between">
                      <button type="button" onClick={() => openWarningEditor(variant.id)} className="rounded-md px-1 py-1 text-[11px] text-gray-400 hover:bg-gray-50 hover:text-primary-600">＋ 调整最低库存预警（默认 0）</button>
                      {product && <span className="text-xs text-gray-400">当前库存：{variant.current_stock || 0} {product.unit || '个'}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 商品级库存预警开关 */}
          <button
            type="button"
            role="switch"
            aria-checked={form.stock_alert_disabled}
            onClick={() => set('stock_alert_disabled', !form.stock_alert_disabled)}
            className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${form.stock_alert_disabled ? 'border-gray-300 bg-gray-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${form.stock_alert_disabled ? 'bg-gray-200 text-gray-600' : 'bg-orange-50 text-orange-500'}`}><BellOff className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-gray-700">不再提醒该商品</span><span className="mt-0.5 block text-xs text-gray-400">开启后所有尺码暂停库存预警，已设置的预警值仍会保留</span></span>
            <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${form.stock_alert_disabled ? 'bg-gray-600' : 'bg-gray-200'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${form.stock_alert_disabled ? 'translate-x-5' : 'translate-x-0.5'}`} /></span>
          </button>

          {/* 一级分类标签（单选） */}
          <div ref={dropdownRef} className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              一级分类标签 <span className="text-xs text-gray-400 font-normal">（单选）</span>
            </label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setTagDropdown(!tagDropdown)}
                className="input flex-1 flex items-center justify-between text-left"
              >
                <span className={form.category ? 'text-gray-900' : 'text-gray-400'}>
                  {form.category || '选择一级标签'}
                </span>
                <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${tagDropdown ? 'rotate-180' : ''}`} />
              </button>
              {form.category && (
                <button
                  type="button"
                  onClick={() => { set('category', ''); set('sub_tags', ''); }}
                  className="px-1.5 text-gray-400 hover:text-gray-600"
                  title="清除"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>

            {tagDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-20 max-h-48 overflow-y-auto">
                {topTags.length === 0 ? (
                  <div className="text-center py-4">
                    <p className="text-xs text-gray-400 mb-1">暂无一级标签</p>
                    <p className="text-[11px] text-gray-300">请前往「标签管理」页面创建</p>
                  </div>
                ) : (
                  topTags.map(tag => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => { set('category', tag.name); set('sub_tags', ''); setTagDropdown(false); }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 ${
                        form.category === tag.name ? 'bg-primary-50 text-primary-700 font-medium' : 'text-gray-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
                        {tag.name}
                      </span>
                      {form.category === tag.name && (
                        <span className="w-2 h-2 rounded-full bg-primary-500" />
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 二级标签（多选） */}
          {form.category && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                二级标签 <span className="text-xs text-gray-400 font-normal">（可多选，{selectedSubTags.length} 已选）</span>
              </label>
              {secondLevelTags.length === 0 ? (
                <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2.5">
                  该一级标签下暂无二级标签，可前往「标签管理」页面添加。
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {secondLevelTags.map(t => {
                    const active = selectedSubTags.includes(t.name);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleSubTag(t.name)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                          active
                            ? 'bg-primary-600 border-primary-600 text-white'
                            : 'bg-white border-gray-300 text-gray-700 hover:border-primary-400'
                        }`}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">商品描述</label>
            <textarea
              className="input min-h-[72px] resize-none"
              placeholder="可选"
              value={form.description}
              onChange={e => set('description', e.target.value)}
            />
          </div>

        </div>
        </div>

        {/* Bottom Actions - inside form */}
        <div
        className="bg-white border-t border-gray-100 px-4 py-3 flex-shrink-0"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-lg mx-auto flex gap-3">
          {product && !confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="btn-danger px-4"
              disabled={deleting}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          ) : null}

          {confirmDelete ? (
            <>
              <div className="flex-1 flex items-center text-sm text-red-600 font-medium">
                确定删除该商品？
              </div>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="btn-secondary flex-1"
                disabled={deleting}
              >
                取消删除
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="btn-danger flex-1"
                disabled={deleting}
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="btn-secondary flex-1">取消</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1">
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : '保存'}
              </button>
            </>
          )}
        </div>
      </div>
      </form>
    </div>
  );
}
