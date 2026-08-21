export default function ProductTagBadges({ product, max = 3, className = '' }) {
  const tags = [
    ...(product?.category ? [{ name: product.category, primary: true }] : []),
    ...String(product?.sub_tags || '').split(',').map(name => name.trim()).filter(Boolean).map(name => ({ name, primary: false })),
  ].filter((tag, index, all) => all.findIndex(item => item.name === tag.name) === index);
  if (!tags.length) return null;
  const visible = tags.slice(0, max);
  const hiddenCount = tags.length - visible.length;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {visible.map(tag => <span key={tag.name} className={`badge max-w-28 truncate ${tag.primary ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}`}>{tag.name}</span>)}
      {hiddenCount > 0 && <span className="badge bg-gray-100 text-gray-500">+{hiddenCount}</span>}
    </div>
  );
}
