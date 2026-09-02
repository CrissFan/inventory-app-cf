import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Search, ScanLine, Package, Pencil, Trash2, History, ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, X, Barcode, Clock, FileSpreadsheet, ListChecks } from 'lucide-react';
import { getProducts, deleteProduct, batchDeleteProducts, getTags } from '../api/client';
import ProductForm from '../components/ProductForm';
import BarcodeScanner from '../components/BarcodeScanner';
import ProductChangesViewer from '../components/ProductChangesViewer';
import useSyncRefresh from '../lib/useSyncRefresh';
import { useAuth } from '../AuthContext';
import BatchProductImport from '../components/BatchProductImport';
import ProductTagFilter, { matchesProductTagFilters } from '../components/ProductTagFilter';

function paginationItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1].filter(page => page >= 1 && page <= total));
  const ordered = [...pages].sort((a, b) => a - b);
  const result = [];
  ordered.forEach((page, index) => {
    if (index > 0 && page - ordered[index - 1] > 1) result.push(`ellipsis_${page}`);
    result.push(page);
  });
  return result;
}

export default function Products() {
  const { user } = useAuth();
  const isViewer = user?.role === 'viewer';
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [showScanner, setShowScanner] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [changeProduct, setChangeProduct] = useState(null);
  const [tags, setTags] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [subFilter, setSubFilter] = useState([]);
  const [subFilterRelation, setSubFilterRelation] = useState('or');
  const [sortBy, setSortBy] = useState('created_desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [detailProduct, setDetailProduct] = useState(null);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const sortRef = useRef(null);

  const sortOptions = [
    { value: 'stock_desc', label: '库存：从高到低' },
    { value: 'stock_asc', label: '库存：从低到高' },
    { value: 'created_desc', label: '创建时间：最新优先' },
    { value: 'created_asc', label: '创建时间：最早优先' },
    { value: 'name_asc', label: '商品名称：正序' },
    { value: 'name_desc', label: '商品名称：倒序' },
  ];

  const loadData = useCallback(async () => {
    try {
      const res = await getProducts(search ? { search } : {});
      setProducts(Array.isArray(res.data) ? res.data : []);
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

  // 加载标签层级，用于一/二级分类筛选
  const loadTags = useCallback(async () => {
    try {
      const res = await getTags();
      setTags(Array.isArray(res.data) ? res.data : []);
    } catch {}
  }, []);
  useEffect(() => { loadTags(); }, [loadTags]);
  useSyncRefresh(loadTags, ['tags']);

  useEffect(() => {
    const handleOutside = (event) => {
      if (sortRef.current && !sortRef.current.contains(event.target)) setShowSortMenu(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  useEffect(() => {
    if (!detailProduct) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setDetailProduct(null); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [detailProduct]);

  // 一级分类 + 二级标签组合筛选（搜索已走云端）
  const displayProducts = products.filter(p => {
    return matchesProductTagFilters(p, categoryFilter, subFilter, subFilterRelation);
  }).sort((a, b) => {
    if (sortBy === 'stock_desc') return (b.current_stock || 0) - (a.current_stock || 0);
    if (sortBy === 'stock_asc') return (a.current_stock || 0) - (b.current_stock || 0);
    if (sortBy === 'created_asc') return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    if (sortBy === 'name_asc') return (a.name || '').localeCompare(b.name || '', 'zh-CN', { numeric: true });
    if (sortBy === 'name_desc') return (b.name || '').localeCompare(a.name || '', 'zh-CN', { numeric: true });
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  const totalPages = Math.max(1, Math.ceil(displayProducts.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (safeCurrentPage - 1) * pageSize;
  const paginatedProducts = displayProducts.slice(pageStart, pageStart + pageSize);

  useEffect(() => { setCurrentPage(1); }, [search, categoryFilter, subFilter, subFilterRelation, sortBy, pageSize]);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const toggleProductSelection = (id) => {
    setSelectedProductIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 500) next.add(id);
      else alert('单次最多选择500个商品');
      return next;
    });
  };

  const allVisibleSelected = paginatedProducts.length > 0 && paginatedProducts.every(product => selectedProductIds.has(product.id));
  const toggleAllVisible = () => {
    setSelectedProductIds(current => {
      const next = new Set(current);
      if (allVisibleSelected) paginatedProducts.forEach(product => next.delete(product.id));
      else {
        for (const product of paginatedProducts) {
          if (next.size >= 500) break;
          next.add(product.id);
        }
      }
      return next;
    });
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedProductIds(new Set());
    setShowBatchDeleteConfirm(false);
  };

  const handleBatchDelete = async () => {
    if (!selectedProductIds.size || batchDeleting) return;
    setBatchDeleting(true);
    try {
      await batchDeleteProducts([...selectedProductIds]);
      setProducts(current => current.filter(product => !selectedProductIds.has(product.id)));
      exitBatchMode();
      loadData();
    } catch (error) {
      alert('批量删除失败：' + (error.response?.data?.error || error.message || '未知错误'));
    } finally {
      setBatchDeleting(false);
    }
  };

  const handleSaved = () => {
    setShowForm(false);
    setEditProduct(null);
    loadData();
  };

  const handleDeleted = () => {
    setShowForm(false);
    setEditProduct(null);
    loadData();
  };

  const handleDelete = async () => {
    if (isViewer || !deleteConfirm) return;
    try {
      await deleteProduct(deleteConfirm.id);
      setDeleteConfirm(null);
      loadData();
    } catch (err) {
      alert('删除失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const clearFilters = () => {
    setCategoryFilter('');
    setSubFilter([]);
  };

  const handleScan = (code) => {
    setShowScanner(false);
    setSearch(code.trim());
    clearFilters();
  };

  if (showScanner) {
    return <BarcodeScanner onScan={handleScan} onClose={() => setShowScanner(false)} />;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">商品管理</h1>
          <p className="text-sm text-gray-500 mt-0.5">{displayProducts.length} 个商品</p>
        </div>
        {!isViewer && <div className="flex flex-wrap justify-end gap-2">
          <button onClick={() => batchMode ? exitBatchMode() : setBatchMode(true)} className={`btn-secondary px-3 ${batchMode ? 'border-primary-300 bg-primary-50 text-primary-700' : ''}`}>
            {batchMode ? <X className="w-4 h-4" /> : <ListChecks className="w-4 h-4" />}
            <span className="hidden sm:inline">{batchMode ? '退出批量' : '批量管理'}</span>
            <span className="sm:hidden">{batchMode ? '退出' : '多选'}</span>
          </button>
          {!batchMode && <>
          <button onClick={() => setShowBatchImport(true)} className="btn-secondary px-3">
            <FileSpreadsheet className="w-4 h-4" />
            <span className="hidden sm:inline">批量导入</span>
            <span className="sm:hidden">导入</span>
          </button>
          <button onClick={() => { setEditProduct(null); setShowForm(true); }} className="btn-primary">
            <Plus className="w-4 h-4" />
            新建
          </button>
          </>}
        </div>}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          className="input pl-9 pr-12"
          placeholder="搜索商品名称、条形码或分类"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setShowScanner(true)}
          className="absolute right-1.5 top-1/2 flex h-8 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-primary-600 hover:bg-primary-50"
          title="扫描条形码搜索"
          aria-label="扫描条形码搜索"
        >
          <ScanLine className="h-5 w-5" />
        </button>
      </div>

      {/* 分类筛选（一级 chips + 二级 chips 多选） */}
      <ProductTagFilter
        tags={tags}
        category={categoryFilter}
        selectedSubTags={subFilter}
        relation={subFilterRelation}
        onCategoryChange={setCategoryFilter}
        onSubTagsChange={setSubFilter}
        onRelationChange={setSubFilterRelation}
        trailing={<div ref={sortRef} className="relative shrink-0 pt-[21px]">
            <button
              type="button"
              onClick={() => setShowSortMenu(current => !current)}
              className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${showSortMenu ? 'border-primary-300 bg-primary-50 text-primary-700' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}
              title="商品排序"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">排序</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showSortMenu ? 'rotate-180' : ''}`} />
            </button>
            {showSortMenu && (
              <div className="absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-xl">
                {sortOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => { setSortBy(option.value); setShowSortMenu(false); }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-gray-50 ${sortBy === option.value ? 'bg-primary-50 font-medium text-primary-700' : 'text-gray-600'}`}
                  >
                    {option.label}
                    {sortBy === option.value && <span className="h-1.5 w-1.5 rounded-full bg-primary-500" />}
                  </button>
                ))}
              </div>
            )}
          </div>}
      />

      {batchMode && (
        <div className="sticky top-[65px] z-20 flex items-center gap-3 rounded-xl border border-primary-200 bg-white/95 px-3 py-2.5 shadow-sm backdrop-blur md:top-3">
          <button type="button" onClick={toggleAllVisible} className="btn-secondary shrink-0 px-3 py-2 text-xs">
            <span className={`flex h-4 w-4 items-center justify-center rounded border ${allVisibleSelected ? 'border-primary-600 bg-primary-600 text-white' : 'border-gray-300'}`}>{allVisibleSelected && '✓'}</span>
            {allVisibleSelected ? '取消当前页全选' : '全选当前页'}
          </button>
          <p className="min-w-0 flex-1 text-sm text-gray-600">已选择 <span className="font-semibold text-primary-700">{selectedProductIds.size}</span> 个商品</p>
          <button type="button" onClick={() => setShowBatchDeleteConfirm(true)} disabled={!selectedProductIds.size} className="btn-danger shrink-0 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-4 w-4" />删除所选</button>
        </div>
      )}

      {/* Product Grid */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : displayProducts.length === 0 ? (
        <div className="card p-12 text-center">
          <Package className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-gray-400 text-sm mb-4">{search || categoryFilter || subFilter.length > 0 ? '未找到匹配的商品' : '还没有商品'}</p>
          {!isViewer && !search && !categoryFilter && subFilter.length === 0 && (
            <button onClick={() => { setEditProduct(null); setShowForm(true); }} className="btn-primary">
              <Plus className="w-4 h-4" /> 新建第一个商品
            </button>
          )}
        </div>
      ) : (
        <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {paginatedProducts.map(p => {
            const classificationTags = [p.category, ...(p.sub_tags || '').split(',').map(item => item.trim())].filter(Boolean);
            const visibleTags = classificationTags.slice(0, 3);
            const hiddenTagCount = Math.max(0, classificationTags.length - visibleTags.length);
            const visibleVariants = (p.variants || []).slice(0, 3);
            const hiddenVariantCount = Math.max(0, (p.variants || []).length - visibleVariants.length);
            return (
            <div key={p.id} className={`card group flex h-full flex-col overflow-hidden ${batchMode ? `border-2 ${selectedProductIds.has(p.id) ? 'border-primary-500 bg-primary-50/30' : 'border-gray-200'}` : ''}`}>
              <button type="button" onClick={() => batchMode ? toggleProductSelection(p.id) : setDetailProduct(p)} className="flex w-full flex-1 items-start gap-3 p-3 text-left hover:bg-gray-50">
                {batchMode && <span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${selectedProductIds.has(p.id) ? 'border-primary-600 bg-primary-600 text-white' : 'border-gray-300 bg-white'}`}>{selectedProductIds.has(p.id) && '✓'}</span>}
                <div className="w-16 h-16 rounded-lg bg-gray-100 flex-shrink-0 overflow-hidden flex items-center justify-center">
                  {p.image_path ? (
                    <img src={p.image_path} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <Package className="w-7 h-7 text-gray-300" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm text-gray-900 truncate">{p.name}</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {(p.variants || []).length} 个尺码 · 总库存 {p.current_stock || 0}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {visibleTags.map((tag, index) => <span key={`${tag}_${index}`} className={`badge ${index === 0 && tag === p.category ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}`}>{tag}</span>)}
                    {hiddenTagCount > 0 && <span className="badge bg-gray-100 text-gray-500">+{hiddenTagCount} 标签</span>}
                    <span className={`badge ${!p.stock_alert_disabled && (p.variants || []).some(v => (Number(v.current_stock) || 0) <= Math.max(0, Number(v.min_stock) || 0)) ? 'bg-orange-50 text-orange-600' : 'bg-green-50 text-green-600'}`}>
                      库存 {p.current_stock} {p.unit}
                    </span>
                    {p.stock_alert_disabled && <span className="badge bg-gray-100 text-gray-500">预警已关闭</span>}
                    {visibleVariants.map(variant => (
                      <span key={variant.id} className={`badge ${!p.stock_alert_disabled && (Number(variant.current_stock) || 0) <= Math.max(0, Number(variant.min_stock) || 0) ? 'bg-orange-50 text-orange-600' : 'bg-gray-100 text-gray-600'}`} title={`${variant.barcode} · ${p.stock_alert_disabled ? '该商品已关闭库存预警' : `预警值 ${Math.max(0, Number(variant.min_stock) || 0)}`}`}>
                        {variant.size} {variant.current_stock || 0}
                      </span>
                    ))}
                    {hiddenVariantCount > 0 && <span className="badge bg-gray-100 text-gray-500">+{hiddenVariantCount} 尺码</span>}
                  </div>
                </div>
              </button>
              {!batchMode && <div className="mt-auto flex shrink-0 border-t border-gray-100 bg-white">
                {!isViewer && <>
                <button
                  onClick={() => { setEditProduct(p); setShowForm(true); }}
                  className="flex-1 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1"
                >
                  <Pencil className="w-3.5 h-3.5" /> 编辑
                </button>
                <div className="w-px bg-gray-100" />
                </>}
                <button
                  onClick={() => setChangeProduct(p)}
                  className="flex-1 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1"
                >
                  <History className="w-3.5 h-3.5" /> 变更
                </button>
                {!isViewer && <>
                <div className="w-px bg-gray-100" />
                <button
                  onClick={() => setDeleteConfirm(p)}
                  className="flex-1 py-2 text-xs font-medium text-red-500 hover:bg-red-50 flex items-center justify-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 删除
                </button>
                </>}
              </div>}
            </div>
          );})}
        </div>
        <div className="card flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 text-xs text-gray-500">
            显示第 {pageStart + 1}–{Math.min(pageStart + pageSize, displayProducts.length)} 个，共 {displayProducts.length} 个商品
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
            <label className="flex items-center gap-1.5 text-xs text-gray-500">
              每页
              <select value={pageSize} onChange={event => setPageSize(Number(event.target.value))} className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-xs text-gray-700 outline-none focus:border-primary-500">
                {[12, 24, 48].map(size => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <nav className="flex items-center gap-1" aria-label="商品分页">
              <button type="button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={safeCurrentPage === 1} className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-35" aria-label="上一页"><ChevronLeft className="h-4 w-4" /></button>
              {paginationItems(safeCurrentPage, totalPages).map(item => typeof item === 'number'
                ? <button key={item} type="button" onClick={() => setCurrentPage(item)} className={`h-8 min-w-8 rounded-lg px-2 text-xs font-medium ${item === safeCurrentPage ? 'bg-primary-600 text-white' : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>{item}</button>
                : <span key={item} className="flex h-8 min-w-5 items-center justify-center text-xs text-gray-400">…</span>)}
              <button type="button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={safeCurrentPage === totalPages} className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-35" aria-label="下一页"><ChevronRight className="h-4 w-4" /></button>
            </nav>
          </div>
        </div>
        </>
      )}

      {/* Product Form Modal */}
      {!isViewer && showForm && (
        <ProductForm
          product={editProduct}
          onClose={() => { setShowForm(false); setEditProduct(null); }}
          onSaved={handleSaved}
          onDelete={handleDeleted}
        />
      )}

      {!isViewer && showBatchImport && (
        <BatchProductImport
          onClose={() => setShowBatchImport(false)}
          onImported={loadData}
        />
      )}

      {/* Product Changes Viewer */}
      {changeProduct && (
        <ProductChangesViewer
          product={changeProduct}
          onClose={() => setChangeProduct(null)}
        />
      )}

      {detailProduct && (
        <ProductDetailPanel product={detailProduct} onClose={() => setDetailProduct(null)} />
      )}

      {/* Delete Confirmation */}
      {!isViewer && deleteConfirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="font-medium text-gray-900">删除商品</h3>
                <p className="text-xs text-gray-400">此操作不可撤销</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              确定要删除「{deleteConfirm.name}」吗？该商品的所有库存记录将一并删除。
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="btn-secondary flex-1">取消</button>
              <button onClick={handleDelete} className="btn-danger flex-1">确认删除</button>
            </div>
          </div>
        </div>
      )}

      {!isViewer && showBatchDeleteConfirm && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => !batchDeleting && setShowBatchDeleteConfirm(false)}>
          <div className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }} onClick={event => event.stopPropagation()}>
            <div className="mb-3 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50"><Trash2 className="h-5 w-5 text-red-500" /></span><div><h3 className="font-medium text-gray-900">批量删除商品</h3><p className="text-xs text-gray-400">已选择 {selectedProductIds.size} 个商品</p></div></div>
            <p className="mb-2 text-sm leading-6 text-gray-600">删除后，所选商品及其库存流水将一并删除，且无法恢复。</p>
            <p className="mb-4 text-xs leading-5 text-gray-400">为避免影响复用同一图片的其他商品，商品图片文件不会从云端存储中删除。</p>
            <div className="flex gap-3"><button type="button" disabled={batchDeleting} onClick={() => setShowBatchDeleteConfirm(false)} className="btn-secondary flex-1">取消</button><button type="button" disabled={batchDeleting} onClick={handleBatchDelete} className="btn-danger flex-1">{batchDeleting ? '正在删除…' : `确认删除 ${selectedProductIds.size} 个`}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProductDetailPanel({ product, onClose }) {
  const formatDate = (value) => value
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
    : '—';

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5">
          <h3 className="font-semibold text-gray-900">商品详情</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex gap-4">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100">
              {product.image_path
                ? <img src={product.image_path} alt={product.name} className="h-full w-full object-contain" />
                : <Package className="h-9 w-9 text-gray-300" />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-gray-900">{product.name}</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {product.category && <span className="badge bg-blue-50 text-blue-600">{product.category}</span>}
                {(product.sub_tags || '').split(',').map(item => item.trim()).filter(Boolean).map(tag => (
                  <span key={tag} className="badge bg-purple-50 text-purple-600">{tag}</span>
                ))}
              </div>
              <p className="mt-3 text-sm text-gray-500">总库存 <span className="font-semibold text-gray-900">{product.current_stock || 0}</span> {product.unit || '个'}</p>
              <p className="mt-1 text-xs text-gray-400">预警按各尺码分别计算</p>
              {product.stock_alert_disabled && <span className="mt-2 inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">该商品已关闭库存预警</span>}
            </div>
          </div>

          <div className="mt-5">
            <h4 className="mb-2 text-sm font-medium text-gray-700">尺码库存</h4>
            <div className="space-y-2">
              {(product.variants || []).map(variant => (
                <div key={variant.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2.5">
                  <span className="min-w-12 rounded-lg bg-gray-100 px-2.5 py-1.5 text-center text-sm font-semibold text-gray-700">{variant.size}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate font-mono text-xs text-gray-500"><Barcode className="h-3.5 w-3.5 shrink-0" />{variant.barcode}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${!product.stock_alert_disabled && (Number(variant.current_stock) || 0) <= Math.max(0, Number(variant.min_stock) || 0) ? 'text-orange-600' : 'text-gray-900'}`}>{variant.current_stock || 0}</p>
                    <p className="text-[10px] text-gray-400">{product.stock_alert_disabled ? '预警已暂停' : `预警 ≤ ${Math.max(0, Number(variant.min_stock) || 0)}`}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {product.description && (
            <div className="mt-5">
              <h4 className="mb-1.5 text-sm font-medium text-gray-700">商品描述</h4>
              <p className="whitespace-pre-wrap rounded-xl bg-gray-50 px-3 py-2.5 text-sm leading-6 text-gray-600">{product.description}</p>
            </div>
          )}

          <div className="mt-5 space-y-2 border-t border-gray-100 pt-4 text-xs text-gray-400">
            <p className="flex items-center gap-2"><Clock className="h-3.5 w-3.5" />创建时间：{formatDate(product.created_at)}</p>
            <p className="flex items-center gap-2"><Clock className="h-3.5 w-3.5" />更新时间：{formatDate(product.updated_at)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
