export default function VariantSelector({ variants = [], value, onChange, tone = 'blue', locked = false, lockedLabel = '尺码已锁定' }) {
  const active = tone === 'green'
    ? 'border-green-500 bg-green-50 text-green-700 ring-green-100'
    : 'border-blue-500 bg-blue-50 text-blue-700 ring-blue-100';
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-gray-700">选择尺码 <span className="text-red-500">*</span></label>
        {locked && <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] text-gray-500">{lockedLabel}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {variants.map(variant => (
          <button
            key={variant.id}
            type="button"
            disabled={locked}
            onClick={() => onChange(variant)}
            className={`rounded-xl border p-3 text-left transition-all ${value?.id === variant.id ? `${active} ring-2` : 'border-gray-200 bg-white hover:border-gray-300'} ${locked && value?.id !== variant.id ? 'opacity-45' : ''} ${locked ? 'cursor-not-allowed' : ''}`}
          >
            <span className="block text-sm font-semibold">{variant.size}</span>
            <span className="mt-1 block truncate font-mono text-[11px] opacity-60">{variant.barcode}</span>
            <span className="mt-1 block text-xs">库存 {variant.current_stock || 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
