import { useState } from 'react';
import { Upload, X, Image as ImageIcon, Images, RefreshCw, Trash2 } from 'lucide-react';
import { getProducts, uploadImage } from '../api/client';

const MAX_SIZE = 200 * 1024;
const MAX_DIMENSION = 1440;

// 商品图压缩到 200KB 以内，同时限制超大图片尺寸，优先输出 WebP。
export const compressProductImage = (file) => new Promise((resolve, reject) => {
  if (file.size <= MAX_SIZE) {
    resolve(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('当前浏览器不支持图片压缩'));

      const initialScale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      let width = Math.max(1, Math.round(img.width * initialScale));
      let height = Math.max(1, Math.round(img.height * initialScale));

      const encode = (quality = 0.82) => {
        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('图片压缩失败'));
          if (blob.size <= MAX_SIZE) {
            const isWebp = blob.type === 'image/webp';
            const extension = isWebp ? '.webp' : '.jpg';
            const name = file.name.replace(/\.[^.]+$/, extension);
            resolve(new File([blob], name, { type: blob.type || 'image/jpeg' }));
            return;
          }
          if (quality > 0.42) {
            encode(quality - 0.08);
            return;
          }
          if (width <= 160 && height <= 160) {
            const extension = blob.type === 'image/webp' ? '.webp' : '.jpg';
            resolve(new File([blob], file.name.replace(/\.[^.]+$/, extension), { type: blob.type || 'image/jpeg' }));
            return;
          }
          width = Math.max(1, Math.round(width * 0.82));
          height = Math.max(1, Math.round(height * 0.82));
          encode(0.78);
        }, 'image/webp', quality);
      };

      encode();
    };
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = event.target.result;
  };
  reader.onerror = () => reject(new Error('文件读取失败'));
  reader.readAsDataURL(file);
});

export default function ImageUpload({ value, onChange, label = '商品图片' }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [existingImages, setExistingImages] = useState([]);

  const handleFile = async (file) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const compressed = await compressProductImage(file);
      const res = await uploadImage(compressed);
      onChange(res.data.url || res.data.path);
    } catch (err) {
      setError(err.response?.data?.error || err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const openLibrary = async () => {
    setShowLibrary(true);
    setLoadingLibrary(true);
    setError('');
    try {
      const res = await getProducts();
      const grouped = new Map();
      for (const product of Array.isArray(res.data) ? res.data : []) {
        const url = product.image_path;
        if (!url) continue;
        const current = grouped.get(url) || { url, names: [] };
        if (product.name && !current.names.includes(product.name)) current.names.push(product.name);
        grouped.set(url, current);
      }
      setExistingImages([...grouped.values()]);
    } catch (err) {
      setError('读取已有商品图片失败');
      setShowLibrary(false);
    } finally {
      setLoadingLibrary(false);
    }
  };

  const chooseExisting = (url) => {
    onChange(url);
    setShowLibrary(false);
  };

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <div className="mb-2 flex items-end justify-between gap-3">
        <label className="block text-sm font-medium text-gray-700">{label}</label>
        <span className="text-[11px] text-gray-400">最长边 1440px · 最大 200KB</span>
      </div>

      {value ? (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
          <div className="flex h-48 items-center justify-center bg-[linear-gradient(45deg,#f3f4f6_25%,transparent_25%),linear-gradient(-45deg,#f3f4f6_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f3f4f6_75%),linear-gradient(-45deg,transparent_75%,#f3f4f6_75%)] bg-[length:16px_16px] bg-[position:0_0,0_8px,8px_-8px,-8px_0px] p-3">
            <img src={value} alt="商品图片" className="h-full w-full rounded-lg object-contain" />
          </div>
          <div className="flex items-center gap-2 border-t border-gray-200 bg-white p-2.5">
            <label className="btn-secondary flex-1 cursor-pointer px-3 py-2 text-xs">
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                disabled={uploading}
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
              <RefreshCw className={`h-3.5 w-3.5 ${uploading ? 'animate-spin' : ''}`} />
              {uploading ? '处理中...' : '更换图片'}
            </label>
            <button type="button" onClick={openLibrary} className="btn-secondary flex-1 px-3 py-2 text-xs">
              <Images className="h-3.5 w-3.5" />
              复用已有
            </button>
            <button
              type="button"
              onClick={() => onChange('')}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500"
              title="移除图片"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="flex h-32 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 text-gray-400 transition-colors hover:border-primary-400 hover:bg-primary-50/50">
            <input
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              disabled={uploading}
              onChange={(event) => handleFile(event.target.files?.[0])}
            />
            {uploading ? (
              <>
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
                <span className="text-sm">压缩并上传中...</span>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <Upload className="h-5 w-5" />
                  <ImageIcon className="h-5 w-5" />
                </div>
                <span className="text-sm">上传新图片</span>
                <span className="text-xs text-gray-300">自动压缩至 200KB</span>
              </>
            )}
          </label>
          <button type="button" onClick={openLibrary} className="btn-secondary w-full py-2 text-xs">
            <Images className="h-4 w-4" />
            从已有商品中复用图片
          </button>
        </div>
      )}

      {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}

      {showLibrary && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setShowLibrary(false)}>
          <div className="flex max-h-[80dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">复用已有商品图片</h3>
                <p className="mt-0.5 text-xs text-gray-400">选择后不会重复上传或占用额外存储</p>
              </div>
              <button type="button" onClick={() => setShowLibrary(false)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loadingLibrary ? (
                <div className="flex h-36 items-center justify-center">
                  <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
                </div>
              ) : existingImages.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-400">暂无可复用的商品图片</div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {existingImages.map(item => (
                    <button
                      key={item.url}
                      type="button"
                      onClick={() => chooseExisting(item.url)}
                      className={`overflow-hidden rounded-xl border bg-white text-left transition-all hover:border-primary-400 hover:shadow-sm ${value === item.url ? 'border-primary-500 ring-2 ring-primary-100' : 'border-gray-200'}`}
                    >
                      <div className="aspect-square bg-gray-50 p-1.5">
                        <img src={item.url} alt="" className="h-full w-full rounded-lg object-contain" loading="lazy" />
                      </div>
                      <p className="truncate border-t border-gray-100 px-2 py-1.5 text-[11px] text-gray-500" title={item.names.join('、')}>
                        {item.names.slice(0, 2).join('、')}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
