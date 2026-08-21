import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, Download, Image as ImageIcon, Images, LoaderCircle, Upload, X } from 'lucide-react';
import { batchCreateProducts, getProducts, uploadImage } from '../api/client';
import { compressProductImage } from './ImageUpload';

const variantId = () => globalThis.crypto?.randomUUID?.() || `variant_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const normalizeHeader = value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const normalizeValue = value => String(value ?? '').trim();
const fieldAliases = {
  name: ['商品名称', '名称', 'productname', 'name'],
  size: ['尺码', '规格', 'size', 'variant'],
  barcode: ['条形码', '条码', 'barcode'],
  category: ['一级分类', '商品分类', '分类', 'category'],
  sub_tags: ['二级标签', '标签', 'subtags'],
  description: ['商品描述', '描述', 'description'],
  unit: ['单位', 'unit'],
  min_stock: ['最低库存', '预警库存', '最低库存预警', 'minstock'],
  image: ['商品图片', '图片', '图片文件名', 'image', 'imagefile'],
};

function findColumn(headers, aliases) {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.findIndex(header => normalizedAliases.has(normalizeHeader(header)));
}

function makeCsvTemplate() {
  return '\uFEFF商品名称,尺码,条形码,一级分类,二级标签,商品描述,单位,最低库存,商品图片\n基础T恤,S,690000000001,上装,"纯色,基础款",示例商品,件,5,基础T恤.jpg\n基础T恤,M,690000000002,上装,"纯色,基础款",示例商品,件,5,基础T恤.jpg\n';
}

const normalizeTagName = value => normalizeValue(value).toLocaleLowerCase('zh-CN');
const fileStem = value => normalizeValue(value).replace(/\.[^.]+$/, '').toLocaleLowerCase('zh-CN');
const splitImageNames = value => normalizeValue(value).split(/[|；;\n]+/).map(item => item.trim()).filter(Boolean);
const splitSubTags = value => normalizeValue(value).split(/[,，、；;]+/).map(item => item.trim()).filter(Boolean);

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function ImagePreview({ file, alt = '' }) {
  const url = useMemo(() => file ? URL.createObjectURL(file) : '', [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return file ? <img src={url} alt={alt} className="h-full w-full object-cover" /> : <ImageIcon className="h-5 w-5 text-gray-300" />;
}

export default function BatchProductImport({ onClose, onImported }) {
  const inputRef = useRef(null);
  const imageInputRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [fileErrors, setFileErrors] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [statuses, setStatuses] = useState({});
  const [summary, setSummary] = useState(null);
  const [imageAssignments, setImageAssignments] = useState({});
  const [uploadedImages, setUploadedImages] = useState({});

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const validGroups = useMemo(() => groups.filter(group => group.errors.length === 0), [groups]);
  const selectedGroups = useMemo(() => groups.filter(group => selected.has(group.key) && group.errors.length === 0 && statuses[group.key]?.state !== 'success'), [groups, selected, statuses]);
  const completedCount = Object.values(statuses).filter(item => item.state === 'success').length;

  const parseFile = async (file) => {
    if (!file) return;
    setParsing(true);
    setFileName(file.name);
    setGroups([]);
    setSelected(new Set());
    setFileErrors([]);
    setStatuses({});
    setSummary(null);
    setImageAssignments({});
    setUploadedImages({});
    try {
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['xlsx', 'xls', 'csv'].includes(extension)) throw new Error('仅支持 .xlsx、.xls 或 .csv 文件');
      const [XLSX, productRes] = await Promise.all([import('xlsx'), getProducts()]);
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('文件中没有可读取的工作表');
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
      if (rows.length < 2) throw new Error('文件中没有商品数据');

      const headers = rows[0];
      const columns = Object.fromEntries(Object.entries(fieldAliases).map(([field, aliases]) => [field, findColumn(headers, aliases)]));
      const missingHeaders = [['name', '商品名称'], ['size', '尺码'], ['barcode', '条形码']]
        .filter(([field]) => columns[field] < 0).map(([, label]) => label);
      if (missingHeaders.length) throw new Error(`缺少必填列：${missingHeaders.join('、')}`);

      const existingBarcodeMap = new Map();
      for (const product of Array.isArray(productRes.data) ? productRes.data : []) {
        for (const variant of product.variants || []) {
          const barcode = normalizeValue(variant.barcode);
          if (barcode) existingBarcodeMap.set(barcode, product.name);
        }
      }

      const groupMap = new Map();
      const barcodeRows = new Map();
      const read = (row, field) => columns[field] < 0 ? '' : normalizeValue(row[columns[field]]);
      rows.slice(1).forEach((row, index) => {
        const rowNumber = index + 2;
        if (!row.some(value => normalizeValue(value))) return;
        const name = read(row, 'name');
        const size = read(row, 'size');
        const barcode = read(row, 'barcode');
        const key = name ? name.toLocaleLowerCase('zh-CN') : `__row_${rowNumber}`;
        let group = groupMap.get(key);
        if (!group) {
          group = {
            key, name: name || `第 ${rowNumber} 行（未填写商品名称）`, category: read(row, 'category'),
            sub_tags: splitSubTags(read(row, 'sub_tags')).join(','), description: read(row, 'description'), unit: read(row, 'unit') || '个',
            variants: [], errors: new Set(), sourceRows: [], imageNames: [],
          };
          groupMap.set(key, group);
        }
        group.sourceRows.push(rowNumber);
        if (!name) group.errors.add(`第 ${rowNumber} 行：商品名称不能为空`);
        if (!size) group.errors.add(`第 ${rowNumber} 行：尺码不能为空`);
        if (!barcode) group.errors.add(`第 ${rowNumber} 行：条形码不能为空`);

        for (const field of ['category', 'sub_tags', 'description', 'unit']) {
          const rawValue = read(row, field);
          const value = field === 'sub_tags' ? splitSubTags(rawValue).join(',') : rawValue;
          if (value && group[field] && value !== group[field]) group.errors.add(`第 ${rowNumber} 行：同名商品的${field === 'category' ? '一级分类' : field === 'sub_tags' ? '二级标签' : field === 'description' ? '描述' : '单位'}不一致`);
          if (value && !group[field]) group[field] = value;
        }

        for (const imageName of splitImageNames(read(row, 'image'))) {
          if (!group.imageNames.some(item => item.toLocaleLowerCase('zh-CN') === imageName.toLocaleLowerCase('zh-CN'))) group.imageNames.push(imageName);
        }

        const minStockText = read(row, 'min_stock');
        const minStock = minStockText === '' ? 0 : Number(minStockText);
        if (!Number.isInteger(minStock) || minStock < 0) group.errors.add(`第 ${rowNumber} 行：最低库存必须是非负整数`);
        if (size && group.variants.some(variant => variant.size.toLocaleLowerCase('zh-CN') === size.toLocaleLowerCase('zh-CN'))) {
          group.errors.add(`第 ${rowNumber} 行：同一商品存在重复尺码「${size}」`);
        }
        group.variants.push({ id: variantId(), size, barcode, current_stock: 0, min_stock: Number.isInteger(minStock) && minStock >= 0 ? minStock : 0, rowNumber });
        if (barcode) {
          const occurrences = barcodeRows.get(barcode) || [];
          occurrences.push({ group, rowNumber });
          barcodeRows.set(barcode, occurrences);
          const existingName = existingBarcodeMap.get(barcode);
          if (existingName) group.errors.add(`第 ${rowNumber} 行：条形码「${barcode}」已被商品「${existingName}」使用`);
        }
      });

      for (const [barcode, occurrences] of barcodeRows) {
        if (occurrences.length > 1) {
          const rowText = occurrences.map(item => item.rowNumber).join('、');
          occurrences.forEach(item => item.group.errors.add(`条形码「${barcode}」在文件第 ${rowText} 行重复`));
        }
      }
      const parsedGroups = [...groupMap.values()].map(group => ({ ...group, errors: [...group.errors] }));
      for (const group of parsedGroups) {
        if (group.sub_tags && !group.category) group.errors.push('填写二级标签时必须同时填写一级分类');
      }
      if (!parsedGroups.length) throw new Error('文件中没有可解析的商品数据');
      setGroups(parsedGroups);
      setSelected(new Set(parsedGroups.filter(group => group.errors.length === 0).map(group => group.key)));
    } catch (error) {
      setFileErrors([error.message || '文件解析失败']);
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const assignImageFiles = (files, targetKey = null) => {
    const imageFiles = [...files].filter(file => file.type.startsWith('image/'));
    if (!imageFiles.length) return;
    setImageAssignments(current => {
      const next = { ...current };
      if (targetKey) {
        next[targetKey] = { files: imageFiles, selectedName: imageFiles[0].name };
        return next;
      }
      for (const group of groups) {
        const declaredNames = group.imageNames.map(name => name.toLocaleLowerCase('zh-CN'));
        const productStem = normalizeTagName(group.name);
        const exactMatches = declaredNames.map(name => imageFiles.find(file => file.name.toLocaleLowerCase('zh-CN') === name)).filter(Boolean);
        const nameMatches = imageFiles.filter(file => !exactMatches.includes(file) && (fileStem(file.name) === productStem || fileStem(file.name).startsWith(`${productStem}-`) || fileStem(file.name).startsWith(`${productStem}_`)));
        const matches = [...exactMatches, ...nameMatches];
        if (matches.length) next[group.key] = { files: matches, selectedName: matches[0].name };
      }
      return next;
    });
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const chooseImage = (groupKey, fileName) => {
    setImageAssignments(current => ({ ...current, [groupKey]: { ...current[groupKey], selectedName: fileName } }));
  };

  const toggleGroup = (group) => {
    if (group.errors.length || statuses[group.key]?.state === 'success' || creating) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
      return next;
    });
  };

  const createSelected = async () => {
    if (!selectedGroups.length) return;
    setCreating(true);
    setSummary(null);
    const imagePaths = { ...uploadedImages };
    let preparationFailed = false;
    await runWithConcurrency(selectedGroups, 4, async group => {
      setStatuses(current => ({ ...current, [group.key]: { state: 'preparing' } }));
      try {
        const assignment = imageAssignments[group.key];
        const selectedImage = assignment?.files?.find(file => file.name === assignment.selectedName) || assignment?.files?.[0];
        if (!imagePaths[group.key] && selectedImage) {
          const compressed = await compressProductImage(selectedImage);
          const imageRes = await uploadImage(compressed);
          imagePaths[group.key] = imageRes.data.url || imageRes.data.path || '';
          setUploadedImages(current => ({ ...current, [group.key]: imagePaths[group.key] }));
        }
      } catch (error) {
        preparationFailed = true;
        setStatuses(current => ({ ...current, [group.key]: { state: 'error', message: `图片上传失败：${error.response?.data?.error || error.message || '未知错误'}` } }));
      }
    });
    if (preparationFailed) {
      for (const group of selectedGroups) {
        setStatuses(current => current[group.key]?.state === 'preparing' ? ({ ...current, [group.key]: { state: 'error', message: '本批存在图片上传失败，尚未创建任何商品' } }) : current);
      }
      setCreating(false);
      setSummary({ succeeded: 0, failed: selectedGroups.length, message: '图片准备失败，本批商品未提交，可直接重试。' });
      return;
    }

    const payload = selectedGroups.map(group => {
      const variants = group.variants.map(({ rowNumber, ...variant }) => variant);
      return {
        name: group.name, variants, category: group.category, sub_tags: group.sub_tags,
        description: group.description, unit: group.unit || '个', image_path: imagePaths[group.key] || '',
        min_stock: variants.reduce((sum, variant) => sum + variant.min_stock, 0),
      };
    });
    selectedGroups.forEach(group => setStatuses(current => ({ ...current, [group.key]: { state: 'creating' } })));
    try {
      await batchCreateProducts(payload);
      selectedGroups.forEach(group => setStatuses(current => ({ ...current, [group.key]: { state: 'success' } })));
      setSummary({ succeeded: selectedGroups.length, failed: 0 });
      onImported?.();
    } catch (error) {
      const message = error.response?.data?.error || error.message || '批量创建失败';
      selectedGroups.forEach(group => setStatuses(current => ({ ...current, [group.key]: { state: 'error', message: `整批未创建：${message}` } })));
      setSummary({ succeeded: 0, failed: selectedGroups.length, message: `批量创建失败，所有商品均未写入：${message}` });
    } finally {
      setCreating(false);
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([makeCsvTemplate()], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '商品批量导入模板.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-gray-50">
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-4 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
        <button type="button" onClick={onClose} className="-ml-1 rounded-lg p-1 hover:bg-gray-100"><ArrowLeft className="h-5 w-5 text-gray-600" /></button>
        <div className="min-w-0 flex-1"><h2 className="font-bold text-gray-900">批量导入商品</h2><p className="truncate text-xs text-gray-400">上传文件并预览，确认后才会创建</p></div>
        <button type="button" onClick={downloadTemplate} className="btn-secondary px-3 py-2 text-xs"><Download className="h-4 w-4" />下载模板</button>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4 pb-28">
          <section className="card p-4">
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={event => parseFile(event.target.files?.[0])} />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={parsing || creating} className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 px-4 py-8 text-center hover:border-primary-400 hover:bg-primary-50/30 disabled:opacity-60">
              {parsing ? <LoaderCircle className="mb-3 h-8 w-8 animate-spin text-primary-500" /> : <Upload className="mb-3 h-8 w-8 text-primary-500" />}
              <p className="text-sm font-medium text-gray-700">{parsing ? '正在解析文件…' : fileName || '选择 Excel 或 CSV 文件'}</p>
              <p className="mt-1 text-xs text-gray-400">支持 .xlsx、.xls、.csv；仅读取第一个工作表</p>
            </button>
            <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-700">
              每行填写一个尺码。同名商品的多行会自动合并；商品名称、尺码、条形码为必填，条形码必须全局唯一。表格中的新标签会按内容自动创建。批量创建不会导入初始库存，请在创建后通过入库功能登记库存。
            </div>
          </section>

          {fileErrors.map(error => <div key={error} className="flex gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>)}

          {groups.length > 0 && (
            <section className="space-y-3">
              <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple className="hidden" onChange={event => assignImageFiles(event.target.files || [])} />
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-50"><Images className="h-5 w-5 text-purple-600" /></span>
                <div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-800">匹配商品图片</p><p className="mt-0.5 text-xs leading-5 text-gray-400">可一次选择多张图片。优先按表格“商品图片”文件名匹配，也会匹配与商品名称同名的图片；每个商品默认选择匹配到的第一张。</p></div>
                <button type="button" disabled={creating} onClick={() => imageInputRef.current?.click()} className="btn-secondary shrink-0 px-3 py-2 text-xs"><Upload className="h-4 w-4" />选择多张图片</button>
              </div>
              <div className="flex items-center justify-between px-1">
                <div><h3 className="text-sm font-semibold text-gray-800">解析预览</h3><p className="text-xs text-gray-400">共 {groups.length} 个商品，{validGroups.length} 个校验通过</p></div>
                <button type="button" disabled={creating} onClick={() => setSelected(new Set(validGroups.filter(group => statuses[group.key]?.state !== 'success').map(group => group.key)))} className="text-xs font-medium text-primary-600 disabled:opacity-50">选择全部有效商品</button>
              </div>
              {groups.map(group => {
                const status = statuses[group.key];
                const checked = selected.has(group.key) || status?.state === 'success';
                return (
                  <article key={group.key} className={`card overflow-hidden border ${group.errors.length ? 'border-red-200' : status?.state === 'success' ? 'border-green-200' : checked ? 'border-primary-300' : 'border-transparent'}`}>
                    <div
                      role="button"
                      tabIndex={group.errors.length || status?.state === 'success' ? -1 : 0}
                      onClick={() => toggleGroup(group)}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleGroup(group); } }}
                      className="flex w-full items-start gap-3 p-4 text-left"
                    >
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${group.errors.length ? 'border-red-300 bg-red-50' : checked ? 'border-primary-600 bg-primary-600 text-white' : 'border-gray-300 bg-white'}`}>
                        {['preparing', 'creating'].includes(status?.state) ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary-600" /> : checked && !group.errors.length ? <CheckCircle2 className="h-3.5 w-3.5" /> : group.errors.length ? <X className="h-3.5 w-3.5 text-red-500" /> : null}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium text-gray-900">{group.name}</h4><span className="badge bg-gray-100 text-gray-500">{group.variants.length} 个尺码</span>{group.category && <span className="badge bg-blue-50 text-blue-600">{group.category}</span>}{splitSubTags(group.sub_tags).map(tag => <span key={tag} className="badge bg-purple-50 text-purple-600">{tag}</span>)}</div>
                        <div className="mt-2 flex flex-wrap gap-1.5">{group.variants.map(variant => <span key={variant.id} className="rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-600">{variant.size || '未填写尺码'} · <span className="font-mono">{variant.barcode || '未填写条形码'}</span></span>)}</div>
                        <div className="mt-3 flex items-start gap-2" onClick={event => event.stopPropagation()}>
                          {(imageAssignments[group.key]?.files || []).length > 0 ? <div className="flex flex-wrap gap-2">{imageAssignments[group.key].files.map(file => <button key={`${file.name}_${file.size}`} type="button" onClick={() => chooseImage(group.key, file.name)} className={`relative h-14 w-14 overflow-hidden rounded-lg border-2 bg-gray-50 ${imageAssignments[group.key].selectedName === file.name ? 'border-primary-500 ring-2 ring-primary-100' : 'border-white'}`} title={file.name}><ImagePreview file={file} alt={group.name} />{imageAssignments[group.key].selectedName === file.name && <span className="absolute right-0.5 top-0.5 rounded-full bg-primary-600 p-0.5 text-white"><CheckCircle2 className="h-3 w-3" /></span>}</button>)}</div> : <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-gray-100"><ImageIcon className="h-5 w-5 text-gray-300" /></span>}
                          <label className="flex h-14 cursor-pointer items-center rounded-lg border border-dashed border-gray-300 px-3 text-xs text-gray-500 hover:border-primary-400 hover:text-primary-600"><input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple className="hidden" disabled={creating || status?.state === 'success'} onChange={event => assignImageFiles(event.target.files || [], group.key)} />{imageAssignments[group.key]?.files?.length ? '更换图片' : group.imageNames.length ? `选择 ${group.imageNames[0]}` : '选择商品图片'}</label>
                        </div>
                        {group.errors.length > 0 && <ul className="mt-2 space-y-1 text-xs text-red-500">{group.errors.map(error => <li key={error}>• {error}</li>)}</ul>}
                        {status?.state === 'error' && <p className="mt-2 text-xs text-red-500">创建失败：{status.message}</p>}
                        {status?.state === 'success' && <p className="mt-2 text-xs font-medium text-green-600">已创建成功</p>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          )}

          {summary && <div className={`rounded-xl px-4 py-3 text-sm ${summary.failed ? 'bg-orange-50 text-orange-700' : 'bg-green-50 text-green-700'}`}>{summary.message || <>本次创建成功 {summary.succeeded} 个{summary.failed ? `，失败 ${summary.failed} 个，可修正文件后重新上传或直接重试` : '，商品列表已更新'}</>}</div>}
        </div>
      </main>

      {groups.length > 0 && (
        <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-gray-200 bg-white px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
          <div className="mx-auto flex max-w-4xl items-center gap-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-700">已选择 {selectedGroups.length} 个待创建商品</p>{completedCount > 0 && <p className="text-xs text-green-600">本文件已有 {completedCount} 个创建成功</p>}</div><button type="button" onClick={completedCount > 0 && selectedGroups.length === 0 ? onClose : createSelected} disabled={creating || (!selectedGroups.length && completedCount === 0)} className="btn-primary min-w-32 justify-center disabled:cursor-not-allowed disabled:opacity-50">{creating ? <><LoaderCircle className="h-4 w-4 animate-spin" />正在创建</> : completedCount > 0 && selectedGroups.length === 0 ? '完成' : `确认创建 ${selectedGroups.length} 个`}</button></div>
        </footer>
      )}
    </div>
  );
}
