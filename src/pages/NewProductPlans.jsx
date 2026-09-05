import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Clock3, Layers3, LoaderCircle, Package, Pencil, Plus, Search, Sparkles, UserRound, X } from 'lucide-react';
import { advanceNewProductPlan, getMaterials, getNewProductPlans, getTeam, saveNewProductPlan } from '../api/client';
import ImageUpload from '../components/ImageUpload';
import { useAuth } from '../AuthContext';
import useSyncRefresh from '../lib/useSyncRefresh';

const STAGES = [
  { key: 'pattern', label: '打版', color: 'bg-blue-500' },
  { key: 'sample', label: '打样', color: 'bg-cyan-500' },
  { key: 'adjust', label: '调整', color: 'bg-amber-500' },
  { key: 'preview', label: '图透', color: 'bg-purple-500' },
  { key: 'listed', label: '上架销售', color: 'bg-green-500' },
];

const stageIndex = stage => Math.max(0, STAGES.findIndex(item => item.key === stage));
const stageLabel = stage => STAGES.find(item => item.key === stage)?.label || '打版';
const dateText = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('zh-CN') : '未设置';

function durationText(start, end) {
  if (!start) return '未开始';
  const milliseconds = Math.max(0, new Date(end || Date.now()).getTime() - new Date(start).getTime());
  const hours = Math.floor(milliseconds / 3600000);
  if (hours < 1) return '< 1小时';
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours ? `${days}天${remainHours}小时` : `${days}天`;
}

export default function NewProductPlans() {
  const { user } = useAuth();
  const canManage = user?.role !== 'viewer';
  const [plans, setPlans] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editor, setEditor] = useState(null);
  const [advancing, setAdvancing] = useState(null);
  const [message, setMessage] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const [planResponse, materialResponse] = await Promise.all([getNewProductPlans(), getMaterials()]);
      setPlans(Array.isArray(planResponse.data) ? planResponse.data : []);
      setMaterials((Array.isArray(materialResponse.data) ? materialResponse.data : []).filter(item => item.kind === 'fabric'));
    } catch (error) { setMessage({ type: 'error', text: error.message || '新品计划读取失败' }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { getTeam().then(response => setMembers((Array.isArray(response.members) ? response.members : []).filter(member => member.role !== 'viewer'))).catch(() => setMembers([])); }, []);
  useSyncRefresh(loadData, ['new_product_plans', 'inventory_materials']);

  const visible = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return plans.filter(plan => filter === 'all' || plan.stage === filter)
      .filter(plan => !keyword || [plan.name, plan.product_type, plan.description, plan.assignee_name, ...(plan.materials || []).map(item => item.name)]
        .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [filter, plans, search]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const inSevenDays = new Date(today); inSevenDays.setDate(inSevenDays.getDate() + 7);
  const active = plans.filter(plan => plan.stage !== 'listed').length;
  const listed = plans.length - active;
  const needsAttention = plans.filter(plan => plan.stage !== 'listed' && plan.planned_launch_date && new Date(`${plan.planned_launch_date}T00:00:00`) <= inSevenDays).length;
  const overallProgress = plans.length ? Math.round(plans.reduce((sum, plan) => sum + stageIndex(plan.stage) / (STAGES.length - 1), 0) / plans.length * 100) : 0;

  const advance = async plan => {
    const index = stageIndex(plan.stage);
    const next = STAGES[index + 1];
    if (!next || !window.confirm(`确认将「${plan.name}」从“${stageLabel(plan.stage)}”推进到“${next.label}”吗？`)) return;
    setAdvancing(plan.id); setMessage(null);
    try {
      const response = await advanceNewProductPlan(plan.id, next.key);
      setPlans(current => current.map(item => String(item.id) === String(plan.id) ? response.data : item));
      setMessage({ type: 'success', text: `「${plan.name}」已进入${next.label}阶段` });
    } catch (error) { setMessage({ type: 'error', text: error.message || '阶段推进失败' }); }
    finally { setAdvancing(null); }
  };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="flex items-center gap-2 text-xl font-bold text-gray-900"><Sparkles className="h-5 w-5 text-purple-500" />新品计划</h1><p className="mt-0.5 text-sm text-gray-500">跟踪从打版到上架销售的全流程</p></div>{canManage && <button type="button" onClick={() => setEditor({})} className="btn-primary"><Plus className="h-4 w-4" />创建新品</button>}</div>

    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Overview icon={Package} label="新品总数" value={plans.length} tone="purple" />
      <Overview icon={Clock3} label="进行中" value={active} tone="blue" />
      <Overview icon={AlertTriangle} label="临近/已逾期" value={needsAttention} tone={needsAttention ? 'orange' : 'gray'} />
      <Overview icon={CheckCircle2} label="已上架" value={listed} tone="green" />
      <div className="card col-span-2 p-4 lg:col-span-1"><p className="text-2xl font-bold text-gray-900">{overallProgress}%</p><p className="text-xs text-gray-500">整体平均进度</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-purple-500" style={{ width: `${overallProgress}%` }} /></div></div>
    </div>

    <div className="card p-4"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium text-gray-700">阶段分布</h2><span className="text-xs text-gray-400">{active} 个新品正在推进</span></div><div className="grid grid-cols-5 gap-2">{STAGES.map(stage => { const count = plans.filter(plan => plan.stage === stage.key).length; return <button type="button" key={stage.key} onClick={() => setFilter(filter === stage.key ? 'all' : stage.key)} className={`rounded-xl px-2 py-3 text-center ${filter === stage.key ? 'bg-primary-50 ring-2 ring-primary-200' : 'bg-gray-50 hover:bg-gray-100'}`}><p className="text-lg font-bold text-gray-800">{count}</p><p className="truncate text-[11px] text-gray-500">{stage.label}</p></button>; })}</div></div>

    {message && <div className={`flex items-center justify-between rounded-xl px-4 py-3 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}><span>{message.text}</span><button onClick={() => setMessage(null)}><X className="h-4 w-4" /></button></div>}

    <div className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input className="input pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索新品、类型、面料或负责人" /></div>{filter !== 'all' && <button type="button" onClick={() => setFilter('all')} className="btn-secondary">清除阶段筛选 · {stageLabel(filter)}</button>}</div>

    {loading ? <div className="flex h-48 items-center justify-center"><LoaderCircle className="h-8 w-8 animate-spin text-primary-500" /></div> : visible.length ? <div className="grid gap-4 xl:grid-cols-2">{visible.map(plan => <PlanCard key={plan.id} plan={plan} canManage={canManage} advancing={advancing === plan.id} onEdit={() => setEditor(plan)} onAdvance={() => advance(plan)} />)}</div> : <div className="card py-16 text-center text-sm text-gray-400"><Sparkles className="mx-auto mb-3 h-11 w-11 text-gray-300" />{search || filter !== 'all' ? '未找到匹配的新品计划' : '暂无新品计划'}</div>}

    {editor && <PlanEditor initial={editor.id ? editor : null} materials={materials} members={members} onClose={() => setEditor(null)} onSaved={async plan => { setEditor(null); setPlans(current => { const exists = current.some(item => String(item.id) === String(plan.id)); return exists ? current.map(item => String(item.id) === String(plan.id) ? plan : item) : [plan, ...current]; }); setMessage({ type: 'success', text: editor.id ? '新品计划已更新' : '新品计划已创建' }); }} />}
  </div>;
}

function Overview({ icon: Icon, label, value, tone }) {
  const colors = { purple: 'bg-purple-50 text-purple-600', blue: 'bg-blue-50 text-blue-600', orange: 'bg-orange-50 text-orange-600', green: 'bg-green-50 text-green-600', gray: 'bg-gray-100 text-gray-500' };
  return <div className="card p-4"><span className={`mb-2 flex h-9 w-9 items-center justify-center rounded-lg ${colors[tone]}`}><Icon className="h-5 w-5" /></span><p className="text-2xl font-bold text-gray-900">{value}</p><p className="text-xs text-gray-500">{label}</p></div>;
}

function StageTimeline({ plan }) {
  const current = stageIndex(plan.stage);
  return <div className="overflow-x-auto pb-1"><div className="grid min-w-[590px] grid-cols-5">{STAGES.map((stage, index) => {
    const reached = index <= current; const active = index === current;
    const started = plan.stage_timestamps?.[stage.key];
    const ended = index < STAGES.length - 1 ? plan.stage_timestamps?.[STAGES[index + 1].key] : null;
    return <div key={stage.key} className="relative text-center"><div className={`absolute left-0 top-3 h-1 w-full ${index < current ? stage.color : 'bg-gray-200'} ${index === 0 ? 'ml-1/2 w-1/2' : index === STAGES.length - 1 ? 'w-1/2' : ''}`} /><span className={`relative mx-auto flex h-7 w-7 items-center justify-center rounded-full border-2 text-[10px] font-bold ${active ? `${stage.color} border-white text-white ring-2 ring-primary-200` : reached ? `${stage.color} border-white text-white` : 'border-gray-200 bg-white text-gray-400'}`}>{reached ? '✓' : index + 1}</span><p className={`mt-1.5 text-xs font-medium ${active ? 'text-primary-700' : reached ? 'text-gray-700' : 'text-gray-400'}`}>{stage.label}</p><p className="mt-0.5 text-[10px] text-gray-400">{reached ? durationText(started, ended) : '未开始'}</p></div>;
  })}</div></div>;
}

function PlanCard({ plan, canManage, advancing, onEdit, onAdvance }) {
  const current = stageIndex(plan.stage); const next = STAGES[current + 1];
  const overdue = plan.stage !== 'listed' && plan.planned_launch_date && new Date(`${plan.planned_launch_date}T23:59:59`) < new Date();
  return <article className="card overflow-hidden"><div className="flex gap-4 p-4"><span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-purple-50">{plan.design_image_url ? <img src={plan.design_image_url} alt={plan.name} className="h-full w-full object-contain" /> : <Sparkles className="h-8 w-8 text-purple-300" />}</span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate font-semibold text-gray-900">{plan.name}</h3><p className="mt-0.5 text-xs text-gray-400">{plan.product_type || '未填写类型'}</p></div>{canManage && <button type="button" onClick={onEdit} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><Pencil className="h-4 w-4" /></button>}</div><div className="mt-2 flex flex-wrap gap-1">{(plan.materials || []).map(material => <span key={material.id} className="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] text-purple-600">{material.name}{material.color_code ? ` · ${material.color_code}` : ''}</span>)}</div></div></div>
    <div className="border-y border-gray-100 px-4 py-4"><StageTimeline plan={plan} /></div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-xs text-gray-500"><span className="flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5" />{plan.assignee_name || '未分配负责人'}</span><span className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-600' : ''}`}><CalendarDays className="h-3.5 w-3.5" />计划上架 {dateText(plan.planned_launch_date)}</span><span className="ml-auto rounded-full bg-gray-100 px-2.5 py-1 font-medium text-gray-600">{stageLabel(plan.stage)}</span></div>
    {plan.description && <p className="mx-4 mb-3 line-clamp-2 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-500">{plan.description}</p>}
    {canManage && next && <div className="border-t border-gray-100 p-3"><button type="button" disabled={advancing} onClick={onAdvance} className="btn-primary w-full">{advancing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{advancing ? '推进中…' : `推进至“${next.label}”`}</button></div>}
  </article>;
}

function PlanEditor({ initial, materials, members, onClose, onSaved }) {
  const [form, setForm] = useState({ id: initial?.id, name: initial?.name || '', product_type: initial?.product_type || '', material_ids: (initial?.materials || []).map(item => String(item.id)), design_image_url: initial?.design_image_url || '', description: initial?.description || '', planned_launch_date: initial?.planned_launch_date || '', assignee_user_id: initial?.assignee_user_id || '' });
  const [materialSearch, setMaterialSearch] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const toggleMaterial = id => set('material_ids', form.material_ids.includes(String(id)) ? form.material_ids.filter(item => item !== String(id)) : [...form.material_ids, String(id)]);
  const filteredMaterials = materials.filter(material => !materialSearch.trim() || [material.name, material.model, material.color_code].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(materialSearch.trim().toLocaleLowerCase('zh-CN'))));
  const submit = async event => { event.preventDefault(); if (!form.name.trim()) return setError('请填写商品名称'); setSaving(true); setError(''); try { const response = await saveNewProductPlan(form); await onSaved(response.data); } catch (e) { setError(e.message || '保存失败'); } finally { setSaving(false); } };

  useEffect(() => { const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = old; }; }, []);
  return <div className="fixed inset-0 z-[100] flex flex-col bg-gray-50"><header className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-4 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}><button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100"><X className="h-5 w-5 text-gray-500" /></button><div><h2 className="font-bold text-gray-900">{initial ? '编辑新品计划' : '创建新品计划'}</h2><p className="text-xs text-gray-400">{initial ? `当前阶段：${stageLabel(initial.stage)}` : '新计划将从“打版”阶段开始'}</p></div></header>
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col"><main className="flex-1 overflow-y-auto p-4"><div className="mx-auto max-w-2xl space-y-4 pb-6">{error && <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}<section className="card space-y-4 p-4"><ImageUpload value={form.design_image_url} onChange={value => set('design_image_url', value)} label="设计图" /><label className="block"><span className="mb-1.5 block text-sm font-medium text-gray-700">商品名称 *</span><input autoFocus className="input" value={form.name} onChange={event => set('name', event.target.value)} placeholder="例如：桃花提花马面裙" /></label><div className="grid grid-cols-2 gap-3"><label><span className="mb-1.5 block text-sm font-medium text-gray-700">商品类型</span><input className="input" value={form.product_type} onChange={event => set('product_type', event.target.value)} placeholder="马面裙/上衣/外套" /></label><label><span className="mb-1.5 block text-sm font-medium text-gray-700">计划上架时间</span><input type="date" className="input" value={form.planned_launch_date} onChange={event => set('planned_launch_date', event.target.value)} /></label></div><label className="block"><span className="mb-1.5 block text-sm font-medium text-gray-700">负责人</span><select className="input" value={form.assignee_user_id} onChange={event => set('assignee_user_id', event.target.value)}><option value="">暂不分配</option>{members.map(member => <option key={member.user_id || member.id} value={member.user_id || member.id}>{member.display_name}{member.role === 'viewer' ? ' · 查看者' : ''}</option>)}</select></label><label className="block"><span className="mb-1.5 block text-sm font-medium text-gray-700">说明</span><textarea className="input min-h-28 resize-y" value={form.description} onChange={event => set('description', event.target.value.slice(0, 2000))} placeholder="记录设计思路、工艺要求或需要关注的事项" /><span className="mt-1 block text-right text-xs text-gray-400">{form.description.length}/2000</span></label></section>
      <section className="card overflow-hidden"><div className="border-b border-gray-100 px-4 py-3"><div className="flex items-center justify-between"><div><h3 className="text-sm font-medium text-gray-800">面料</h3><p className="mt-0.5 text-xs text-gray-400">可从面辅料库中多选</p></div><span className="text-xs font-medium text-primary-600">已选 {form.material_ids.length}</span></div><div className="relative mt-3"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input type="search" className="input pl-9" value={materialSearch} onChange={event => setMaterialSearch(event.target.value)} placeholder="搜索面料名称、型号或色号" /></div></div><div className="max-h-64 divide-y divide-gray-100 overflow-y-auto">{filteredMaterials.length ? filteredMaterials.map(material => { const checked = form.material_ids.includes(String(material.id)); return <button key={material.id} type="button" onClick={() => toggleMaterial(material.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${checked ? 'border-primary-600 bg-primary-600 text-white' : 'border-gray-300'}`}>{checked && '✓'}</span><Layers3 className="h-4 w-4 shrink-0 text-purple-500" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-gray-700">{material.name}</span><span className="block truncate text-xs text-gray-400">型号 {material.model || '—'} · 色号 {material.color_code || '—'}</span></span></button>; }) : <p className="px-4 py-8 text-center text-sm text-gray-400">{materialSearch ? '未找到匹配面料' : '面辅料库中暂无面料'}</p>}</div></section></div></main>
      <footer className="shrink-0 border-t border-gray-200 bg-white px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}><div className="mx-auto flex max-w-2xl gap-3"><button type="button" onClick={onClose} disabled={saving} className="btn-secondary flex-1">取消</button><button type="submit" disabled={saving} className="btn-primary flex-1">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{saving ? '保存中…' : '保存新品计划'}</button></div></footer></form>
  </div>;
}
