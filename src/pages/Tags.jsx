import { useState, useEffect, useCallback } from 'react';
import { Plus, Tag, Trash2, X, Check, Layers, CornerDownRight } from 'lucide-react';
import { getTags, createTag, deleteTag } from '../api/client';
import useSyncRefresh from '../lib/useSyncRefresh';
import { useAuth } from '../AuthContext';

export default function Tags() {
  const { user } = useAuth();
  const isViewer = user?.role === 'viewer';
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);

  // 一级标签添加
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);

  // 二级标签添加（按一级标签 id）
  const [subInput, setSubInput] = useState({}); // parentId -> 输入值
  const [addingSub, setAddingSub] = useState({}); // parentId -> loading

  // 编辑
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  // 校验错误提示（空值 / 重名）
  const [topError, setTopError] = useState('');
  const [subError, setSubError] = useState({});

  const loadTags = useCallback(async () => {
    try {
      const res = await getTags();
      setTags(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to load tags:', err);
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);
  useSyncRefresh(loadTags, ['tags']);

  const topTags = tags.filter(t => !t.parent_id);
  const getChildren = (id) => tags.filter(t => t.parent_id === id);

  // 同层级（同 parent_id）重名校验，不区分大小写；excludeId 用于编辑时排除自身
  const isDuplicate = (name, parentId, excludeId = null) =>
    tags.some(t =>
      (t.parent_id ?? null) === (parentId ?? null) &&
      t.id !== excludeId &&
      t.name.trim().toLowerCase() === name.trim().toLowerCase()
    );

  // 添加一级标签
  const handleAddTop = async (e) => {
    e.preventDefault();
    if (isViewer) return;
    const name = input.trim();
    if (!name) { setTopError('标签名称不能为空'); return; }
    if (isDuplicate(name, null)) { setTopError(`一级标签「${name}」已存在`); return; }
    setTopError('');
    setAdding(true);
    try {
      const res = await createTag(name, null);
      setTags(prev => [...prev, res.data]);
      setInput('');
    } catch (err) {
      alert(err.response?.data?.error || '添加失败');
    } finally {
      setAdding(false);
    }
  };

  // 添加二级标签
  const handleAddSub = async (parentId) => {
    if (isViewer) return;
    const name = (subInput[parentId] || '').trim();
    if (!name) { setSubError(prev => ({ ...prev, [parentId]: '标签名称不能为空' })); return; }
    if (isDuplicate(name, parentId)) { setSubError(prev => ({ ...prev, [parentId]: `二级标签「${name}」已存在` })); return; }
    setSubError(prev => ({ ...prev, [parentId]: '' }));
    setAddingSub(prev => ({ ...prev, [parentId]: true }));
    try {
      const res = await createTag(name, parentId);
      setTags(prev => [...prev, res.data]);
      setSubInput(prev => ({ ...prev, [parentId]: '' }));
    } catch (err) {
      alert(err.response?.data?.error || '添加失败');
    } finally {
      setAddingSub(prev => ({ ...prev, [parentId]: false }));
    }
  };

  const handleDeleteTop = async (tag) => {
    if (isViewer) return;
    const children = getChildren(tag.id);
    const msg = children.length > 0
      ? `确定删除一级标签「${tag.name}」及其 ${children.length} 个二级标签？`
      : `确定删除标签「${tag.name}」？`;
    if (!confirm(msg)) return;
    try {
      await deleteTag(tag.id);
      setTags(prev => prev.filter(t => t.id !== tag.id && t.parent_id !== tag.id));
    } catch (err) {
      alert('删除失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleDeleteSub = async (tag) => {
    if (isViewer) return;
    if (!confirm(`确定删除二级标签「${tag.name}」？`)) return;
    try {
      await deleteTag(tag.id);
      setTags(prev => prev.filter(t => t.id !== tag.id));
    } catch (err) {
      alert('删除失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const startEdit = (tag) => {
    if (isViewer) return;
    setEditingId(tag.id);
    setEditValue(tag.name);
  };

  const saveEdit = async (tag) => {
    if (isViewer) return;
    const newName = editValue.trim();
    if (!newName) { alert('标签名称不能为空'); return; }
    if (newName === tag.name) { setEditingId(null); return; }
    if (isDuplicate(newName, tag.parent_id ?? null, tag.id)) { alert(`标签「${newName}」已存在`); return; }
    try {
      // 保留层级：删除旧 + 创建新（沿用父级）
      await deleteTag(tag.id);
      const res = await createTag(newName, tag.parent_id ?? null);
      setTags(prev => prev.map(t => t.id === tag.id ? res.data : t));
    } catch (err) {
      alert('编辑失败: ' + (err.response?.data?.error || err.message));
    } finally {
      setEditingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">标签管理</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          一级标签为商品的主分类（单选），其下可创建多个二级标签（多选）。
        </p>
      </div>

      {/* Add Top-level Tag */}
      {!isViewer && <form onSubmit={handleAddTop} className="flex gap-2">
        <div className="relative flex-1">
          <Layers className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            className="input pl-9"
            placeholder="输入一级标签名称，回车添加"
            value={input}
            onChange={e => { setInput(e.target.value); if (topError) setTopError(''); }}
            maxLength={20}
          />
        </div>
        <button
          type="submit"
          disabled={adding || !input.trim()}
          className="btn-primary px-4 flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          一级标签
        </button>
      </form>}

      {!isViewer && topError && (
        <p className="text-xs text-red-500">{topError}</p>
      )}

      {/* Tag Tree */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin w-6 h-6 border-2 border-primary-600 border-t-transparent rounded-full" />
        </div>
      ) : tags.length === 0 ? (
        <div className="card py-16 text-center">
          <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Tag className="w-7 h-7 text-gray-400" />
          </div>
          <p className="text-sm font-medium text-gray-500">暂无标签</p>
          {!isViewer && <p className="text-xs text-gray-400 mt-1">先添加一个一级标签，再在其下创建二级标签</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {topTags.map(top => {
            const children = getChildren(top.id);
            return (
              <div key={top.id} className="card p-3.5">
                {/* Top-level row */}
                <div className="flex items-center justify-between gap-2">
                  {!isViewer && editingId === top.id ? (
                    <div className="flex items-center gap-1.5 flex-1">
                      <input
                        className="flex-1 px-2 py-1 text-sm border border-primary-300 rounded-md outline-none focus:border-primary-500"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEdit(top);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        autoFocus
                        maxLength={20}
                      />
                      <button onClick={() => saveEdit(top)} className="p-1 text-green-600 hover:bg-green-50 rounded">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditingId(null)} className="p-1 text-gray-400 hover:bg-gray-100 rounded">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full bg-primary-500 flex-shrink-0" />
                        <span className="text-sm font-medium text-gray-800 truncate">{top.name}</span>
                        <span className="text-[11px] text-gray-400 flex-shrink-0">{children.length} 个二级</span>
                      </div>
                      {!isViewer && <div className="flex items-center gap-0.5">
                        <button
                          onClick={() => startEdit(top)}
                          className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                          title="编辑"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteTop(top)}
                          className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>}
                    </>
                  )}
                </div>

                {/* Children */}
                {children.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5 pl-4.5">
                    {children.map(child => (
                      <span
                        key={child.id}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-purple-50 text-purple-700 rounded-full text-xs group"
                      >
                        <CornerDownRight className="w-3 h-3 opacity-50" />
                        {!isViewer && editingId === child.id ? (
                          <input
                            className="w-16 px-1 py-0.5 text-xs border border-primary-300 rounded outline-none"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveEdit(child);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            autoFocus
                            maxLength={20}
                          />
                        ) : (
                          <span>{child.name}</span>
                        )}
                        {!isViewer && editingId !== child.id && (
                          <span className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => startEdit(child)}
                              className="p-0.5 text-purple-400 hover:text-purple-700"
                              title="编辑"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleDeleteSub(child)}
                              className="p-0.5 text-purple-400 hover:text-red-500"
                              title="删除"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {/* Add sub-tag */}
                {!isViewer && <div className="flex items-center gap-1.5 mt-2.5 pl-4.5">
                  <CornerDownRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
                  <input
                    className="flex-1 px-2 py-1 text-xs border border-dashed border-gray-300 rounded-md outline-none focus:border-primary-400 text-gray-600"
                    placeholder="添加二级标签，回车确认"
                    value={subInput[top.id] || ''}
                    onChange={e => { setSubInput(prev => ({ ...prev, [top.id]: e.target.value })); if (subError[top.id]) setSubError(prev => ({ ...prev, [top.id]: '' })); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddSub(top.id); } }}
                    maxLength={20}
                  />
                  <button
                    type="button"
                    onClick={() => handleAddSub(top.id)}
                    disabled={addingSub[top.id] || !(subInput[top.id] || '').trim()}
                    className="px-2 py-1 text-xs text-primary-600 hover:bg-primary-50 rounded disabled:opacity-40"
                  >
                    {addingSub[top.id] ? '...' : '添加'}
                  </button>
                </div>}
                {!isViewer && subError[top.id] && (
                  <p className="text-xs text-red-500 pl-4.5">{subError[top.id]}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Tip */}
      {!isViewer && tags.length > 0 && (
        <div className="text-xs text-gray-400 bg-gray-50 rounded-lg px-4 py-2.5">
          提示：新建/编辑商品时，先选一个一级标签，再勾选其下的二级标签（可多选）。
        </div>
      )}
    </div>
  );
}
