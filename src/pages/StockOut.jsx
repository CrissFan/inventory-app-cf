import { useEffect, useState, useCallback } from 'react';
import { ArrowUpFromLine, ArrowLeft, Search, ScanLine, Check, Package, ChevronRight, AlertTriangle } from 'lucide-react';
import { getProducts, stockOut, getProductByBarcode, getTags } from '../api/client';
import { useAuth } from '../AuthContext';
import BarcodeScanner from '../components/BarcodeScanner';
import ReasonSelector from '../components/ReasonSelector';
import VariantSelector from '../components/VariantSelector';
import useSyncRefresh from '../lib/useSyncRefresh';
import ProductTagBadges from '../components/ProductTagBadges';
import ProductTagFilter, { matchesProductTagFilters } from '../components/ProductTagFilter';

const STOCK_OUT_REASONS = [
  { value: '发货', description: '订单或日常销售发货' },
  { value: '瑕疵', description: '破损、过期等异常出库' },
];

export default function StockOut() {
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tags, setTags] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [subFilter, setSubFilter] = useState([]);
  const [subFilterRelation, setSubFilterRelation] = useState('or');
  const [selected, setSelected] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [variantLocked, setVariantLocked] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('发货');
  const [submitting, setSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [success, setSuccess] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const res = await getProducts(search ? { search } : {});
      const list = Array.isArray(res.data) ? res.data : [];
      setProducts(list);
      setSelected(current => {
        const refreshed = current ? (list.find(p => p.id === current.id) || current) : current;
        if (refreshed) setSelectedVariant(active => refreshed.variants?.find(v => v.id === active?.id) || active);
        return refreshed;
      });
    } catch (err) {
      console.error('Failed to load products:', err);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(loadData, 300);
    return () => clearTimeout(timer);
  }, [loadData]);
  useSyncRefresh(loadData, ['products']);

  const loadTags = useCallback(async () => {
    try {
      const response = await getTags();
      setTags(Array.isArray(response.data) ? response.data : []);
    } catch {}
  }, []);
  useEffect(() => { loadTags(); }, [loadTags]);
  useSyncRefresh(loadTags, ['tags']);

  const displayProducts = products.filter(product => matchesProductTagFilters(product, categoryFilter, subFilter, subFilterRelation));

  const handleSubmit = async () => {
    if (!selected || !selectedVariant) {
      alert('请选择出库尺码');
      return;
    }
    if (quantity <= 0) return;
    if (quantity > selectedVariant.current_stock) {
      alert(`库存不足，该尺码库存仅 ${selectedVariant.current_stock}`);
      return;
    }
    if (!reason) {
      alert('请选择出库原因');
      return;
    }
    setSubmitting(true);
    try {
      const res = await stockOut({
        product_id: selected.id,
        variant_id: selectedVariant.id,
        quantity: parseInt(quantity),
        reason,
        operator: user?.display_name || '未知用户',
      });
      setSuccess({
        product: selected,
        variant: selectedVariant,
        quantity: parseInt(quantity),
        currentStock: res?.data?.product?.variants?.find(v => v.id === selectedVariant.id)?.current_stock
          ?? Math.max(0, (selectedVariant.current_stock || 0) - parseInt(quantity)),
      });
      if (res?.data?.product) {
        setProducts(current => current.map(product => product.id === res.data.product.id ? res.data.product : product));
      }
      setSelected(null);
      setSelectedVariant(null);
      setVariantLocked(false);
      setQuantity(1);
      setReason('发货');
    } catch (err) {
      alert('出库失败: ' + (err.response?.data?.error || err.message));
    } finally {
      setSubmitting(false);
    }
  };

  const handleScan = async (code) => {
    setShowScanner(false);
    try {
      const res = await getProductByBarcode(code);
      if (res.data) {
        setSelected(res.data);
        setSelectedVariant(res.data.selected_variant || (res.data.variants?.length === 1 ? res.data.variants[0] : null));
        setVariantLocked(true);
      }
    } catch (err) {
      if (err.response?.status === 404) {
        alert('未找到该条形码对应的商品，请先在商品管理中添加');
      } else {
        alert('查询失败: ' + (err.response?.data?.error || err.message));
      }
    }
  };

  if (showScanner) {
    return <BarcodeScanner onScan={handleScan} onClose={() => setShowScanner(false)} />;
  }

  if (success) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
          <Check className="w-8 h-8 text-blue-500" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-1">出库成功</h2>
        <p className="text-sm text-gray-500 mb-1">{success.product?.name} · {success.variant?.size}</p>
        <ProductTagBadges product={success.product} className="mb-2 justify-center" />
        <p className="text-2xl font-bold text-blue-600 mb-6">−{success.quantity} {success.product?.unit || '个'}</p>
        <p className="text-sm text-gray-400 mb-6">该尺码库存: {success.currentStock} {success.product?.unit || '个'}</p>
        <div className="flex gap-3">
          <button onClick={() => setSuccess(null)} className="btn-secondary">继续出库</button>
        </div>
      </div>
    );
  }

  if (selected) {
    const lowStockVariants = selected.stock_alert_disabled ? [] : (selected.variants || []).filter(v => (Number(v.current_stock) || 0) <= Math.max(0, Number(v.min_stock) || 0));
    const lowStock = lowStockVariants.length > 0;
    const insufficient = selectedVariant ? quantity > selectedVariant.current_stock : false;

    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setSelected(null); setSelectedVariant(null); setVariantLocked(false); }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            aria-label="返回商品选择"
            title="返回商品选择"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">出库</h1>
            <p className="text-sm text-gray-500 mt-0.5">减少商品库存</p>
          </div>
        </div>

        {/* Selected Product */}
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-lg bg-gray-100 flex-shrink-0 overflow-hidden flex items-center justify-center">
              {selected.image_path ? (
                <img src={selected.image_path} alt={selected.name} className="w-full h-full object-cover" />
              ) : (
                <Package className="w-6 h-6 text-gray-400" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-gray-900">{selected.name}</h3>
              <p className="text-xs text-gray-400 mt-0.5">
                总库存: <span className="text-gray-600 font-medium">{selected.current_stock}</span>
              </p>
              <ProductTagBadges product={selected} className="mt-1.5" />
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setShowScanner(true)} className="p-2 hover:bg-gray-100 rounded-lg" title="扫码切换">
                <ScanLine className="w-4 h-4 text-gray-500" />
              </button>
              <button onClick={() => { setSelected(null); setSelectedVariant(null); setVariantLocked(false); }} className="text-xs text-primary-600 hover:underline">更换</button>
            </div>
          </div>
          {lowStock && (
            <div className="flex items-center gap-1.5 mt-3 px-3 py-2 bg-orange-50 rounded-lg text-xs text-orange-600">
              <AlertTriangle className="w-3.5 h-3.5" />
              尺码库存预警：{lowStockVariants.map(v => `${v.size} ${v.current_stock}/${v.min_stock}`).join('、')}
            </div>
          )}
        </div>

        {/* Form */}
        <div className="card p-5 space-y-4">
          <VariantSelector variants={selected.variants} value={selectedVariant} onChange={setSelectedVariant} locked={variantLocked} />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">出库数量</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="w-10 h-10 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center justify-center text-lg"
              >−</button>
              <input
                type="number"
                min="1"
                max={selectedVariant?.current_stock || 0}
                className={`input text-center text-lg font-bold ${insufficient ? 'border-red-300 focus:border-red-500 focus:ring-red-200' : ''}`}
                value={quantity}
                onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              />
              <button
                onClick={() => setQuantity(Math.min(selectedVariant?.current_stock || 0, quantity + 1))}
                className="w-10 h-10 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center justify-center text-lg"
              >+</button>
            </div>
            {insufficient && (
              <p className="text-xs text-red-500 mt-1">超出该尺码可用库存 ({selectedVariant?.current_stock || 0})</p>
            )}
            <div className="flex gap-2 mt-2">
              <button onClick={() => setQuantity(selectedVariant?.current_stock || 0)} disabled={!selectedVariant} className="px-3 py-1 text-xs rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-40">该尺码全部出库</button>
            </div>
          </div>

          <ReasonSelector
            label="出库原因"
            value={reason}
            onChange={setReason}
            options={STOCK_OUT_REASONS}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">操作人</label>
            <input
              className="input bg-gray-50 text-gray-600 cursor-not-allowed"
              value={user?.display_name || ''}
              disabled
              readOnly
            />
          </div>

          <div className="pt-2">
            <button onClick={handleSubmit} disabled={submitting || insufficient} className="btn-primary w-full">
              <ArrowUpFromLine className="w-4 h-4" />
              {submitting ? '提交中...' : `确认出库 ${quantity}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">出库</h1>
          <p className="text-sm text-gray-500 mt-0.5">选择要出库的商品</p>
        </div>
        <button onClick={() => setShowScanner(true)} className="btn-secondary px-3">
          <ScanLine className="w-4 h-4" />
          <span className="hidden sm:inline">扫码</span>
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          className="input pl-9"
          placeholder="搜索商品名称或条形码"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <ProductTagFilter
        tags={tags}
        category={categoryFilter}
        selectedSubTags={subFilter}
        relation={subFilterRelation}
        onCategoryChange={setCategoryFilter}
        onSubTagsChange={setSubFilter}
        onRelationChange={setSubFilterRelation}
      />

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : displayProducts.length === 0 ? (
        <div className="card p-12 text-center text-gray-400 text-sm">
          <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
          {search || categoryFilter || subFilter.length ? '未找到匹配的商品' : '暂无商品'}
        </div>
      ) : (
        <div className="card divide-y divide-gray-50">
          {displayProducts.map(p => (
            <button
              key={p.id}
              onClick={() => { setSelected(p); setSelectedVariant(p.variants?.length === 1 ? p.variants[0] : null); setVariantLocked(false); setQuantity(1); }}
              className="w-full flex items-center gap-3 p-3.5 hover:bg-gray-50 text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex-shrink-0 overflow-hidden flex items-center justify-center">
                {p.image_path ? (
                  <img src={p.image_path} alt={p.name} className="w-full h-full object-cover" />
                ) : (
                  <Package className="w-5 h-5 text-gray-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm text-gray-900 truncate">{p.name}</p>
                <p className="text-xs text-gray-400">库存 {p.current_stock} {p.unit}</p>
                <ProductTagBadges product={p} className="mt-1" />
              </div>
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
