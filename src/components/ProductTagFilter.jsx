export function matchesProductTagFilters(product, category, selectedSubTags, relation = 'or') {
  if (category && product.category !== category) return false;
  if (!selectedSubTags?.length) return true;
  const productSubTags = String(product.sub_tags || '').split(/[,，、；;]+/).map(value => value.trim()).filter(Boolean);
  return relation === 'and'
    ? selectedSubTags.every(tag => productSubTags.includes(tag))
    : selectedSubTags.some(tag => productSubTags.includes(tag));
}

export default function ProductTagFilter({
  tags = [], category = '', selectedSubTags = [], relation = 'or',
  onCategoryChange, onSubTagsChange, onRelationChange, trailing = null,
}) {
  const topTags = tags.filter(tag => !tag.parent_id);
  const selectedTop = topTags.find(tag => tag.name === category);
  const subTags = selectedTop ? tags.filter(tag => tag.parent_id === selectedTop.id) : [];

  const clear = () => {
    onCategoryChange?.('');
    onSubTagsChange?.([]);
  };
  const selectTop = name => {
    onCategoryChange?.(category === name ? '' : name);
    onSubTagsChange?.([]);
  };
  const toggleSub = name => onSubTagsChange?.(
    selectedSubTags.includes(name) ? selectedSubTags.filter(value => value !== name) : [...selectedSubTags, name]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-xs font-medium text-gray-500">一级分类</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={clear} className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${!category ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'}`}>全部</button>
            {topTags.map(tag => <button key={tag.id} type="button" onClick={() => selectTop(tag.name)} className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${category === tag.name ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'}`}>{tag.name}</button>)}
          </div>
        </div>
        {trailing}
      </div>

      {category && subTags.length > 0 && <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-gray-500">二级标签 <span className="font-normal text-gray-400">（可多选）</span></p>
          <div className="flex shrink-0 rounded-lg bg-gray-100 p-0.5" role="group" aria-label="二级标签筛选关系">
            <button type="button" onClick={() => onRelationChange?.('or')} className={`rounded-md px-2.5 py-1 text-xs transition-colors ${relation === 'or' ? 'bg-white font-medium text-purple-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`} title="匹配任意一个所选标签">或</button>
            <button type="button" onClick={() => onRelationChange?.('and')} className={`rounded-md px-2.5 py-1 text-xs transition-colors ${relation === 'and' ? 'bg-white font-medium text-purple-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`} title="同时包含全部所选标签">且</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {subTags.map(tag => <button key={tag.id} type="button" onClick={() => toggleSub(tag.name)} className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${selectedSubTags.includes(tag.name) ? 'border-purple-600 bg-purple-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'}`}>{tag.name}</button>)}
        </div>
      </div>}

      {(category || selectedSubTags.length > 0) && <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400">已筛选：{category || '全部'}{selectedSubTags.length > 0 && ` / ${selectedSubTags.length} 个二级标签${selectedSubTags.length > 1 ? `（${relation === 'and' ? '且' : '或'}）` : ''}`}</p>
        <button type="button" onClick={clear} className="shrink-0 text-xs text-gray-500 underline hover:text-gray-700">清除筛选</button>
      </div>}
    </div>
  );
}
