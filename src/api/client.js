/**
 * 统一 API 客户端
 *
 * 优先使用 Supabase 云端，离线时自动降级到本地 IndexedDB。
 * 写操作：本地立即可用（写入 IndexedDB），后台同步到 Supabase。
 * 读操作：优先从本地读（毫秒级），后台从云端刷新。
 */

import axios from 'axios';
import { createEphemeralSupabase, getSupabase, isSupabaseAvailable } from '../lib/supabase';
import * as localDb from '../lib/localDb';
import {
  triggerSync, pushToCloud, pullFromCloud, initSync, stopSync,
  getSyncStatus, resetAndPull, resolveCloudContext, operationId, queueForSync,
  requestBackgroundSync, markLocalRealtimeEcho, blockBackgroundSync,
} from '../lib/syncEngine';

// =============== 模式检测 ===============

const USE_CLOUD = isSupabaseAvailable();
const supabase = getSupabase();

// 本地 API（Express 后端兜底）
const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

// =============== Auth token (本地 API 用) ===============

function getToken() {
  try { return localStorage.getItem('inventory_token'); } catch { return null; }
}

function setToken(token) {
  try { localStorage.setItem('inventory_token', token); } catch {}
}

function clearToken() {
  try { localStorage.removeItem('inventory_token'); localStorage.removeItem('inventory_user'); } catch {}
}

function saveUser(user) {
  try { localStorage.setItem('inventory_user', JSON.stringify(user)); } catch {}
}

export function getSavedUser() {
  try {
    const raw = localStorage.getItem('inventory_user');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      clearToken();
      window.dispatchEvent(new Event('auth:logout'));
    }
    return Promise.reject(err);
  }
);

// =============== 辅助 ===============

function generateLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return new Date().toISOString();
}

function emitSyncData(tables) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:data', { detail: { tables, source: 'local-write' } }));
  }
}

function assertCanWrite() {
  if (getSavedUser()?.role === 'viewer') {
    throw new Error('查看者仅可浏览，不能执行此操作');
  }
}

/**
 * 通用写操作：先写本地，再尝试写云端
 */
async function writeWithSync(table, action, data, localId) {
  const upsertLocal = async (row) => {
    const name = table === 'stock_movements' ? 'upsertMovement'
      : table === 'tags' ? 'upsertTag' : 'upsertProduct';
    const existing = table === 'products' && row?.id ? await localDb.getProduct(row.id) : null;
    const r = table === 'products' ? normalizeProduct({ ...(existing || {}), ...row }) : row;
    await localDb[name](r);
  };
  const deleteLocal = async (id) => {
    const name = table === 'stock_movements' ? 'deleteMovement'
      : table === 'tags' ? 'deleteTag' : 'deleteProduct';
    try { if (localDb[name]) await localDb[name](id); } catch {}
  };

  // 云端优先：在线时直接写 Supabase，成功后再把云端真实 ID 同步到本地（避免本地/云端双写重复）
  if (USE_CLOUD && navigator.onLine !== false) {
    const teamId = await localDb.getMeta('team_id');
    blockBackgroundSync();
    try {
      switch (action) {
        case 'insert': {
          // 关键：必须携带 team_id，否则 RLS 拒绝写入 → 数据只存本地、无法跨端同步
          const payload = teamId ? { ...data, team_id: teamId } : data;
          const { data: inserted, error } = await supabase.from(table).insert([payload]).select().single();
          if (!error && inserted) {
            const rowToCache = table === 'products' ? normalizeProduct(inserted) : inserted;
            await upsertLocal({ ...rowToCache, synced_at: now() });
            return { data: inserted, cloud: true };
          }
          throw error || new Error('Insert failed');
        }
        case 'update': {
          const { id, ...rest } = data;
          const { data: updated, error } = await supabase.from(table).update(rest).eq('id', id).select().single();
          if (!error && updated) {
            const rowToCache = table === 'products' ? normalizeProduct(updated) : updated;
            await upsertLocal({ ...rowToCache, synced_at: now() });
            return { data: updated, cloud: true };
          }
          // 云端更新失败（如该 id 在云端不存在）：保留本地更新、入队重试，绝不新建商品
          throw error || new Error('Update failed');
        }
        case 'delete': {
          const { error } = await supabase.from(table).delete().eq('id', data.id);
          if (!error) {
            await deleteLocal(data.id);
            return { data: { id: data.id }, cloud: true };
          }
          throw error || new Error('Delete failed');
        }
      }
    } catch (err) {
      console.warn(`[API] Cloud ${action} failed, fallback to local:`, err.message);
      // 更新失败：保留原有 id，本地已写入，入队重试云端更新（绝不生成新商品 / 重复行）
      if (action === 'update') {
        await upsertLocal({ ...data, synced_at: now() });
        await queueForSync({ table, action, data }, err);
        return { data, cloud: false, queued: true };
      }
      // 删除失败：本地已在 deleteProduct 中删除，这里只入队云端重试，绝不重建空记录
      if (action === 'delete') {
        await queueForSync({ table, action, data }, err);
        return { data: { id: data.id }, cloud: false, queued: true };
      }
      // 新增失败：本地立即可用，后台同步
      const id = localId || generateLocalId();
      const row = { ...data, id, synced_at: now() };
      await upsertLocal(row);
      await queueForSync({
        table, action,
        data: { ...data },
        localId: id,
      }, err);
      return { data: { ...data, id }, cloud: false, queued: true };
    }
  }

  // 离线 / 非云端模式：写本地 + 入队
  if (action === 'update') {
    // 编辑：保持原 id 更新，绝不新建
    await upsertLocal({ ...data, synced_at: now() });
    await queueForSync({ table, action, data });
    return { data, cloud: false, queued: true };
  }
  if (action === 'delete') {
    // 删除：本地已在 deleteProduct 中删除，只入队云端重试，不重建空记录
    await queueForSync({ table, action, data });
    return { data: { id: data.id }, cloud: false, queued: true };
  }
  const id = localId || generateLocalId();
  const row = { ...data, id, synced_at: now() };
  await upsertLocal(row);
  await queueForSync({
    table, action,
    data: { ...data },
    localId: id,
  });
  return { data: { ...data, id }, cloud: false, queued: true };
}

// =============== Auth API ===============

export const registerUser = async ({ username, password, display_name, team_name }) => {
  if (USE_CLOUD) {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: `${username}@inventory.local`,
      password,
      options: { data: { display_name, team_name } },
    });

    if (authError || !authData?.user) throw new Error(authError?.message || '注册失败，请稍后重试');
    if (!authData.session) throw new Error('注册成功，请先完成邮箱确认后再登录');

    const { data: created, error: teamError } = await supabase.rpc('create_team_for_current_user', {
      p_name: team_name || '我的团队',
      p_display_name: display_name || username,
    });
    if (teamError) throw new Error(`创建团队失败：${teamError.message}。请确认已执行 supabase-sync-fix.sql`);
    const membership = Array.isArray(created) ? created[0] : created;
    await localDb.activateCacheScope(authData.user.id, membership.team_id);
    const user = {
      id: authData.user.id,
      username,
      display_name: display_name || username,
      role: membership.role || 'admin',
      team: { id: membership.team_id, name: membership.team_name, invite_code: membership.invite_code },
      mode: 'cloud',
    };
    saveUser(user);
    return { user };
  }

  // 本地模式：仅走 Express API
  const res = await api.post('/auth/register', { username, password, display_name, team_name });
  setToken(res.data.token);
  saveUser({ ...res.data.user, mode: 'local' });
  return res.data;
};

export const loginUser = async ({ username, password, team_id }) => {
  if (USE_CLOUD) {
    // 云端模式：Supabase 是主路径
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: `${username}@inventory.local`,
      password,
    });

    if (authError || !authData?.user) throw new Error(authError?.message || '用户名或密码错误');
    const { membership } = await resolveCloudContext();
    const user = {
      id: authData.user.id,
      username,
      display_name: membership.display_name || authData.user.user_metadata?.display_name || username,
      role: membership.role,
      team: { id: membership.team_id, name: membership.team_name, invite_code: membership.invite_code },
      mode: 'cloud',
    };
    saveUser(user);
    return { user };
  }

  // 本地模式：仅走 Express API
  const res = await api.post('/auth/login', { username, password, team_id });
  setToken(res.data.token);
  saveUser({ ...res.data.user, mode: 'local' });
  return res.data;
};

export const joinTeam = async ({ invite_code, username, password, display_name }) => {
  if (USE_CLOUD) {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: `${username}@inventory.local`,
      password,
      options: { data: { display_name } },
    });
    if (authError || !authData?.user) throw new Error(authError?.message || '加入失败，请检查用户名/密码');
    if (!authData.session) throw new Error('注册成功，请先完成邮箱确认后再登录');
    const { data: joined, error: joinError } = await supabase.rpc('join_team_by_invite', {
      p_invite_code: (invite_code || '').trim(),
      p_display_name: display_name || username,
    });
    if (joinError) throw new Error(`加入团队失败：${joinError.message}`);
    const membership = Array.isArray(joined) ? joined[0] : joined;
    await localDb.activateCacheScope(authData.user.id, membership.team_id);
    const user = {
      id: authData.user.id, username, display_name: display_name || username,
      role: membership.role || 'member', mode: 'cloud',
      team: { id: membership.team_id, name: membership.team_name, invite_code: membership.invite_code },
    };
    saveUser(user);
    return { user };
  }
  // 本地模式
  const res = await api.post('/auth/join', { invite_code, username, password, display_name });
  setToken(res.data.token);
  saveUser({ ...res.data.user, mode: 'local' });
  return res.data;
};

export const getMe = async () => {
  if (USE_CLOUD && supabase?.auth?.getSession) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      const { membership } = await resolveCloudContext();
      const saved = getSavedUser() || {};
      const user = {
        ...saved,
        id: session.user.id,
        display_name: membership.display_name || session.user.user_metadata?.display_name || saved.display_name,
        role: membership.role,
        team: { id: membership.team_id, name: membership.team_name, invite_code: membership.invite_code },
        mode: 'cloud',
      };
      saveUser(user);
      return { user };
    }
  }
  const res = await api.get('/auth/me');
  saveUser({ ...res.data.user, mode: 'local' });
  return res.data;
};

export const logout = () => {
  stopSync().catch(() => {});
  if (USE_CLOUD) supabase?.auth?.signOut?.();
  clearToken();
  window.dispatchEvent(new Event('auth:logout'));
};

// =============== Team API ===============

export const getTeam = async () => {
  if (USE_CLOUD) {
    const user = getSavedUser();
    const teamId = await localDb.getMeta('team_id');
    if (!user?.id || !teamId) return { team: null, members: [], myRole: null };
    const [teamResult, membersResult] = await Promise.all([
      supabase.from('teams').select('*').eq('id', teamId).single(),
      supabase.from('team_members').select('id, user_id, display_name, role, created_at').eq('team_id', teamId),
    ]);
    if (teamResult.error) throw new Error(teamResult.error.message || '读取团队失败');
    if (membersResult.error) throw new Error(membersResult.error.message || '读取成员失败');
    const team = { ...teamResult.data };
    const myRole = membersResult.data?.find(member => member.user_id === user.id)?.role || user.role || null;
    // 邀请码缺失时自动补全（仅管理员可更新）
    if (!team.invite_code && myRole === 'admin') {
      const code = `INV_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const { error } = await supabase.from('teams').update({ invite_code: code }).eq('id', team.id);
      if (!error) team.invite_code = code;
    }
    return { team, members: membersResult.data || [], myRole };
  }
  return (await api.get('/team')).data;
};

export const addMember = async (data) => {
  if (USE_CLOUD) {
    const teamId = await localDb.getMeta('team_id');
    if (!teamId) throw new Error('未找到团队信息');
    // 独立临时客户端注册成员，不再切换并恢复当前管理员会话。
    const signupClient = createEphemeralSupabase();
    const { data: authData, error: authError } = await signupClient.auth.signUp({
      email: `${data.username}@inventory.local`,
      password: data.password,
      options: { data: { display_name: data.display_name || data.username } },
    });
    if (authError || !authData?.user) {
      throw new Error(authError?.message || '创建成员失败');
    }
    // 加入团队
    const { data: member, error } = await supabase.from('team_members').insert([{
      team_id: teamId,
      user_id: authData.user.id,
      display_name: data.display_name || data.username,
      role: data.role || 'member',
      created_at: now(),
    }]).select('id, user_id, display_name, role, created_at').single();
    if (error) throw new Error(error.message || '添加成员失败');
    return { ok: true, member };
  }
  const res = await api.post('/team/members', data);
  return res.data;
};

export const updateMember = async (id, data) => {
  if (USE_CLOUD) {
    const teamId = await localDb.getMeta('team_id');
    if (!teamId) throw new Error('未找到团队信息');
    const updates = {};
    if (data.display_name != null) updates.display_name = data.display_name;
    if (data.role) updates.role = data.role;
    const { data: member, error } = await supabase.from('team_members')
      .update(updates).eq('id', id).eq('team_id', teamId)
      .select('id, user_id, display_name, role, created_at').single();
    if (error) throw new Error(error.message || '更新失败');
    return { ok: true, member };
  }
  const res = await api.put(`/team/members/${id}`, data);
  return res.data;
};

export const removeMember = async (id) => {
  if (USE_CLOUD) {
    const teamId = await localDb.getMeta('team_id');
    if (!teamId) throw new Error('未找到团队信息');
    const { error } = await supabase.from('team_members')
      .delete().eq('id', id).eq('team_id', teamId);
    if (error) throw new Error(error.message || '移除失败');
    return { ok: true, id };
  }
  const res = await api.delete(`/team/members/${id}`);
  return res.data;
};

export const updateTeamName = async (name) => {
  if (USE_CLOUD) {
    const { team } = await getTeam();
    if (!team?.id) throw new Error('未找到团队信息');
    const { error } = await supabase.from('teams').update({ name }).eq('id', team.id);
    if (error) throw new Error(error.message || '更新失败');
    return { ok: true };
  }
  const res = await api.put('/team', { name });
  return res.data;
};

export const regenerateInviteCode = async () => {
  if (USE_CLOUD) {
    const { team } = await getTeam();
    if (!team?.id) throw new Error('未找到团队信息');
    const code = `INV_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { error } = await supabase.from('teams').update({ invite_code: code }).eq('id', team.id);
    if (error) throw new Error(error.message || '刷新失败');
    return { invite_code: code };
  }
  const res = await api.post('/team/invite-code');
  return res.data;
};

// =============== Product API ===============

const toBoolean = value => value === true || value === 1 || String(value).trim().toLowerCase() === 'true';

// 商品行归一化：云端 image_url -> 本地模型 image_path
const normalizeProduct = (p) => {
  const variants = Array.isArray(p.variants) && p.variants.length
    ? p.variants.map(variant => ({
        ...variant,
        current_stock: Number(variant.current_stock) || 0,
        min_stock: Number(variant.min_stock ?? p.min_stock) || 0,
      }))
    : [{
        id: `legacy_${p.id}`,
        size: '默认规格',
        barcode: p.barcode || '',
        current_stock: Number(p.current_stock) || 0,
        min_stock: Number(p.min_stock) || 0,
      }];
  return {
    ...p,
    barcode: '',
    variants,
    current_stock: variants.reduce((sum, variant) => sum + variant.current_stock, 0),
    created_at: p.created_at || p.synced_at || null,
    updated_at: p.updated_at || p.created_at || p.synced_at || null,
    image_path: p.image_path || p.image_url || '',
    stock_alert_disabled: toBoolean(p.stock_alert_disabled),
    status: p.status || 'done',
  };
};

// 本地模型 -> 云端 products 表字段
const toCloudProduct = (data) => {
  const { image_path, ...rest } = data;
  return { ...rest, barcode: '', image_url: image_path || '' };
};

// 按条形码查重（云端优先 + 本地兜底）
const findProductByBarcode = async (barcode) => {
  const code = (barcode || '').trim();
  if (!code) return null;
  if (USE_CLOUD) {
    const teamId = await localDb.getMeta('team_id');
    if (teamId) {
      const { data, error } = await supabase.from('products')
        .select('*').eq('team_id', teamId)
        .contains('variants', [{ barcode: code }]).limit(1);
      if (!error && data && data.length) {
        const product = normalizeProduct(data[0]);
        return { ...product, selected_variant: product.variants.find(v => v.barcode === code) };
      }
    }
  }
  const local = await localDb.getProductByBarcode(code);
  return local || null;
};

export const getProducts = async (params = {}) => {
  if (!USE_CLOUD) return api.get('/products', { params });
  const search = (params.search || '').toLowerCase();
  const filterLocal = (list) => search
    ? list.filter(p =>
        (p.name || '').toLowerCase().includes(search) ||
        (p.barcode || '').toLowerCase().includes(search) ||
        (p.category || '').toLowerCase().includes(search) ||
        (p.sub_tags || '').toLowerCase().includes(search) ||
        (p.variants || []).some(v =>
          (v.barcode || '').toLowerCase().includes(search) ||
          (v.size || '').toLowerCase().includes(search)))
    : list;

  // stale-while-revalidate：缓存立即展示，后台统一同步远端并通过 sync:data 更新页面。
  const local = (await localDb.getAllProducts())
    .filter(p => p && p.name)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  requestBackgroundSync();
  return { data: filterLocal(local) };
};

export const getProduct = async (id) => {
  if (!USE_CLOUD) return api.get(`/products/${id}`);
  const local = await localDb.getProduct(id);
  if (local) return { data: local };
  if (USE_CLOUD) {
    const { data } = await supabase.from('products').select('*').eq('id', id).single();
    if (data) return { data: normalizeProduct(data) };
  }
  const res = await api.get(`/products/${id}`);
  return { data: res.data };
};

export const getProductByBarcode = async (barcode) => {
  if (!USE_CLOUD) {
    try { return await api.get(`/products/barcode/${encodeURIComponent(barcode)}`); }
    catch (error) { if (error.response?.status === 404) return { data: null }; throw error; }
  }
  const local = await localDb.getProductByBarcode(barcode);
  if (local) return { data: local };
  if (USE_CLOUD) {
    const teamId = await localDb.getMeta('team_id');
    if (teamId) {
      const { data } = await supabase.from('products').select('*').eq('team_id', teamId)
        .contains('variants', [{ barcode: barcode.trim() }]).limit(1);
      if (data?.length) {
        const product = normalizeProduct(data[0]);
        return { data: { ...product, selected_variant: product.variants.find(v => v.barcode === barcode.trim()) } };
      }
      return { data: null };
    }
  }
  try {
    const res = await api.get(`/products/barcode/${barcode}`);
    return { data: res.data };
  } catch {
    return { data: null };
  }
};

// 记录商品变更（创建/编辑/删除）
export const recordProductChange = async (change) => {
  const teamId = await localDb.getMeta('team_id');
  const user = getSavedUser();
  const row = {
    ...change,
    team_id: teamId,
    user_id: user?.id || null,
    user_name: user?.display_name || null,
    created_at: now(),
  };
  // 本地
  await localDb.upsertProductChange(row);
  // 云端
  if (USE_CLOUD && navigator.onLine !== false) {
    try {
      await supabase.from('product_changes').insert([row]);
    } catch (e) {
      console.warn('[Changes] cloud log failed:', e.message);
    }
  }
};

export const createProduct = async (data) => {
  assertCanWrite();
  if (!USE_CLOUD) return api.post('/products', data);
  for (const variant of data.variants || []) {
    const code = (variant.barcode || '').trim();
    const existing = code ? await findProductByBarcode(code) : null;
    if (existing) {
      throw new Error(`尺码「${variant.size}」的条形码「${code}」已被商品「${existing.name}」占用`);
    }
  }
  const variants = (data.variants || []).map(v => ({ ...v, current_stock: 0 }));
  const timestamp = now();
  const res = await writeWithSync('products', 'insert', {
    ...toCloudProduct(data), variants, current_stock: 0,
    created_at: data.created_at || timestamp,
    updated_at: data.updated_at || timestamp,
  });
  await recordProductChange({
    product_id: res.data?.id,
    action: 'create',
    field: '创建商品',
    old_value: '',
    new_value: data.name || '',
    product_name: data.name || '',
    product_image: data.image_path || '',
  });
  return res;
};

export const batchCreateProducts = async (products) => {
  assertCanWrite();
  if (!Array.isArray(products) || !products.length) throw new Error('请至少选择一个商品');
  if (!USE_CLOUD) return api.post('/products/batch', { products });
  if (navigator.onLine === false) throw new Error('批量创建需要连接云端，请联网后重试');
  blockBackgroundSync();

  const payload = products.map(product => ({
    name: String(product.name || '').trim(),
    description: product.description || '',
    category: product.category || '',
    sub_tags: product.sub_tags || '',
    image_url: product.image_path || product.image_url || '',
    stock_alert_disabled: Boolean(product.stock_alert_disabled),
    min_stock: Number(product.min_stock) || 0,
    variants: (product.variants || []).map(variant => ({
      id: variant.id,
      size: String(variant.size || '').trim(),
      barcode: String(variant.barcode || '').trim(),
      current_stock: 0,
      min_stock: Math.max(0, Number(variant.min_stock) || 0),
    })),
  }));
  const { data, error } = await supabase.rpc('batch_create_products', { p_products: payload });
  if (error) {
    if (/batch_create_products|schema cache|PGRST202/i.test(error.message || '')) {
      throw new Error('数据库批量创建接口尚未部署，请先执行 batch-products-migration.sql');
    }
    throw new Error(error.message || '批量创建商品失败');
  }
  const created = Array.isArray(data?.products) ? data.products.map(normalizeProduct) : [];
  const returnedTags = Array.isArray(data?.tags) ? data.tags : [];
  await Promise.all([
    created.length ? localDb.upsertProducts(created) : Promise.resolve(),
    returnedTags.length ? localDb.replaceTags(returnedTags) : Promise.resolve(),
  ]);
  emitSyncData(['products', 'tags']);
  return { data: { ...data, products: created } };
};

export const updateProduct = async (id, data) => {
  assertCanWrite();
  if (!USE_CLOUD) return api.put(`/products/${id}`, data);
  for (const variant of data.variants || []) {
    const code = (variant.barcode || '').trim();
    const existing = code ? await findProductByBarcode(code) : null;
    if (existing && existing.id !== id) {
      throw new Error(`尺码「${variant.size}」的条形码「${code}」已被商品「${existing.name}」占用`);
    }
  }
  // 读取旧值对比
  const old = await localDb.getProduct(id);
  const oldProduct = normalizeProduct(old || {});
  const labels = {
    name: '名称', variants: '尺码规格', description: '描述', stock_alert_disabled: '库存预警提醒',
    category: '分类', sub_tags: '二级标签', image_path: '图片', min_stock: '最低库存',
  };
  const changed = [];
  for (const key of Object.keys(labels)) {
    const oldVal = oldProduct[key] ?? '';
    const newVal = data[key] ?? '';
    if (String(oldVal) !== String(newVal)) {
      changed.push({ field: labels[key], old_value: oldVal, new_value: newVal, isImage: key === 'image_path' });
    }
  }
  // 先更新本地
  await localDb.upsertProduct(normalizeProduct({ ...oldProduct, ...data, id, synced_at: now() }));
  // 再写云端
  const res = await writeWithSync('products', 'update', { id, ...toCloudProduct(data) });
  for (const c of changed) {
    await recordProductChange({
      product_id: id,
      action: 'update',
      field: c.field,
      old_value: c.isImage ? '' : c.old_value,
      new_value: c.isImage ? '' : c.new_value,
      product_name: data.name || oldProduct.name || '',
      product_image: data.image_path || oldProduct.image_path || '',
    });
  }
  return res;
};

export const deleteProduct = async (id) => {
  assertCanWrite();
  if (!USE_CLOUD) return api.delete(`/products/${id}`);
  const old = await localDb.getProduct(id);
  const oldProduct = normalizeProduct(old || {});
  await localDb.deleteProduct(id);
  const res = await writeWithSync('products', 'delete', { id });
  await recordProductChange({
    product_id: id,
    action: 'delete',
    field: '删除商品',
    old_value: oldProduct.name || '',
    new_value: '',
    product_name: oldProduct.name || '',
    product_image: oldProduct.image_path || '',
  });
  return res;
};

export const batchDeleteProducts = async (ids) => {
  assertCanWrite();
  const rawIds = [...new Set(ids || [])];
  if (!rawIds.length) throw new Error('请至少选择一个商品');
  if (rawIds.length > 500) throw new Error('单次最多删除500个商品');
  if (!USE_CLOUD) {
    const productIds = rawIds.map(Number);
    if (!productIds.every(Number.isSafeInteger)) throw new Error('商品 ID 无效，请刷新后重试');
    return api.post('/products/batch-delete', { product_ids: productIds });
  }

  const idMap = (await localDb.getMeta('cloud_id_map')) || {};
  const cloudIds = [];
  const localOnlyIds = [];
  const cleanupIds = new Set(rawIds);
  for (const rawId of rawIds) {
    const directId = Number(rawId);
    const mappedId = Number(idMap[rawId]);
    if (Number.isSafeInteger(directId)) cloudIds.push(directId);
    else if (Number.isSafeInteger(mappedId)) {
      cloudIds.push(mappedId);
      cleanupIds.add(mappedId);
    } else localOnlyIds.push(rawId);
  }
  const uniqueCloudIds = [...new Set(cloudIds)];
  if (uniqueCloudIds.length && navigator.onLine === false) throw new Error('所选商品包含云端数据，批量删除需要联网后执行');
  if (uniqueCloudIds.length) blockBackgroundSync();

  let cloudResult = { deleted_count: 0, product_ids: [] };
  if (uniqueCloudIds.length) {
    const { data, error } = await supabase.rpc('batch_delete_products', { p_product_ids: uniqueCloudIds });
    if (error) {
      if (/batch_delete_products|schema cache|PGRST202/i.test(error.message || '')) {
        throw new Error('数据库批量删除接口尚未部署，请先执行 batch-delete-products-migration.sql');
      }
      if (/请至少选择一个商品/.test(error.message || '')) {
        throw new Error(`数据库未正确解析所选商品 ID（前端已提交 ${uniqueCloudIds.length} 个），请重新执行最新版 batch-delete-products-migration.sql`);
      }
      throw new Error(error.message || '批量删除商品失败');
    }
    cloudResult = data || cloudResult;
  }

  await localDb.deleteProductsWithRelatedData([...cleanupIds]);
  let idMapChanged = false;
  for (const [localId, cloudId] of Object.entries(idMap)) {
    if (cleanupIds.has(localId) || uniqueCloudIds.includes(Number(cloudId))) {
      delete idMap[localId];
      idMapChanged = true;
    }
  }
  if (idMapChanged) await localDb.setMeta('cloud_id_map', idMap);
  return { data: {
    ...cloudResult,
    deleted_count: Number(cloudResult.deleted_count || 0) + localOnlyIds.length,
    local_deleted_count: localOnlyIds.length,
  } };
};

export const uploadImage = async (file) => {
  assertCanWrite();
  // 优先 Supabase Storage
  if (USE_CLOUD) {
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const fileName = `product_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { data, error } = await supabase.storage.from('product-images').upload(fileName, file, {
        cacheControl: '3600',
        upsert: false,
      });
      if (!error) {
        const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(fileName);
        return { data: { path: fileName, url: publicUrl } };
      }
      console.warn('[Upload] Supabase Storage failed:', error.message);
    } catch (supaErr) {
      console.warn('[Upload] Supabase Storage error:', supaErr.message);
    }
  }

  // 降级：本地 API
  const formData = new FormData();
  formData.append('image', file);
  return api.post('/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
};

// =============== Stock API ===============

async function changeStock(type, data) {
  assertCanWrite();
  if (!USE_CLOUD) {
    // 本地部署模式由 Express + SQLite 的事务保证库存与流水一致。
    return api.post(type === 'in' ? '/stock/in' : '/stock/out', data);
  }

  const teamId = await localDb.getMeta('team_id');
  if (!teamId) throw new Error('缺少团队信息，请重新登录');
  const quantity = Number(data.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('数量必须是大于0的整数');
  const clientOperationId = data.client_operation_id || operationId('stock');
  const payload = {
    ...data,
    quantity,
    type,
    team_id: teamId,
    client_operation_id: clientOperationId,
    variant_id: data.variant_id,
    created_at: now(),
  };

  if (navigator.onLine !== false) {
    blockBackgroundSync();
    markLocalRealtimeEcho('stock_movements', 'client_operation_id', clientOperationId);
    const result = await supabase.rpc('apply_variant_stock_movement', {
      p_product_id: Number(data.product_id),
      p_variant_id: data.variant_id,
      p_type: type,
      p_quantity: quantity,
      p_reason: data.reason || '',
      p_operator: data.operator || '',
      p_client_operation_id: clientOperationId,
    });
    if (result.error) {
      await queueForSync({ action: 'stock_movement', data: payload }, result.error);
      if (/apply_variant_stock_movement|schema cache|PGRST202|products\.variants|column .*variants/i.test(result.error.message || '')) {
        throw new Error('数据库尺码迁移尚未完成：缺少 products.variants 或新版库存 RPC。请完整执行 product-variants-migration.sql 后重试。');
      }
      throw new Error(`云端出入库失败，操作已进入待同步队列：${result.error.message}`);
    }
    const product = result.data?.product ? normalizeProduct(result.data.product) : null;
    const movement = result.data?.movement || null;
    if (product) await localDb.upsertProduct(product);
    if (movement) await localDb.upsertMovement(movement);
    return { data: { success: true, product, movement, duplicate: !!result.data?.duplicate } };
  }

  // 真正离线时才乐观更新本地；恢复网络后以相同幂等键调用云端事务。
  const product = await localDb.getProduct(data.product_id);
  if (!product) throw new Error('本地没有该商品，联网同步后再试');
  const variant = (product.variants || []).find(v => v.id === data.variant_id);
  if (!variant) throw new Error('本地没有该商品尺码，联网同步后再试');
  if (type === 'out' && (variant.current_stock || 0) < quantity) {
    throw new Error(`尺码 ${variant.size} 库存不足，当前库存 ${variant.current_stock || 0}`);
  }
  const variants = product.variants.map(v => v.id === variant.id
    ? { ...v, current_stock: (v.current_stock || 0) + (type === 'in' ? quantity : -quantity) }
    : v);
  const updated = {
    ...product,
    variants,
    current_stock: variants.reduce((sum, v) => sum + (v.current_stock || 0), 0),
    updated_at: now(),
  };
  const movement = {
    ...payload, id: generateLocalId(),
    variant_size: variant.size, variant_barcode: variant.barcode,
  };
  await localDb.upsertProduct(updated);
  await localDb.upsertMovement(movement);
  await queueForSync({ action: 'stock_movement', data: movement });
  return { data: { success: true, product: updated, movement, queued: true } };
}

export const stockIn = async (data) => changeStock('in', data);

export const stockOut = async (data) => changeStock('out', data);

// =============== Factory Pending Inventory API ===============

const normalizeFactoryItem = row => {
  const product = normalizeProduct(row.product || row.products || {});
  const variants = Array.isArray(row.variants) ? row.variants.map(variant => ({
    ...variant,
    quantity: Math.max(0, Number(variant.quantity) || 0),
  })) : [];
  return {
    ...row,
    status: 'doing',
    variants,
    total_quantity: variants.reduce((sum, variant) => sum + variant.quantity, 0),
    product,
  };
};

export const getFactoryInventory = async () => {
  if (!USE_CLOUD) return api.get('/factory-inventory');
  const [items, products] = await Promise.all([
    localDb.getAllFactoryInventory(),
    localDb.getAllProducts(),
  ]);
  const productMap = new Map(products.map(product => [String(product.id), product]));
  requestBackgroundSync();
  return {
    data: items
      .map(item => normalizeFactoryItem({
        ...item,
        product: productMap.get(String(item.product_id)) || item.product,
      }))
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)),
  };
};

export const setFactoryInventory = async (productId, variants) => {
  assertCanWrite();
  const clean = (variants || []).map(variant => ({
    id: variant.id,
    quantity: Math.max(0, Number.parseInt(variant.quantity, 10) || 0),
  }));
  if (!clean.length) throw new Error('商品至少需要一个尺码');
  if (!USE_CLOUD) return api.put(`/factory-inventory/${productId}`, { variants: clean });
  if (navigator.onLine === false) throw new Error('待出货库存录入需要连接云端，请联网后重试');
  blockBackgroundSync();
  const { data, error } = await supabase.rpc('set_factory_inventory', {
    p_product_id: Number(productId),
    p_variant_ids: clean.map(variant => variant.id),
    p_quantities: clean.map(variant => variant.quantity),
  });
  if (error) {
    if (/set_factory_inventory|schema cache|PGRST202/i.test(error.message || '')) throw new Error('数据库待出货功能尚未部署，请先执行 factory-inventory-migration.sql');
    throw new Error(error.message || '保存待出货库存失败');
  }
  if (data?.factory) await localDb.upsertFactoryInventory(data.factory);
  if (data?.change) await localDb.upsertProductChange(data.change);
  emitSyncData(['factory_inventory', 'product_changes']);
  return { data: normalizeFactoryItem({ ...data.factory, product: data.product }) };
};

export const addFactoryInventory = async (productId, variants, note = '') => {
  assertCanWrite();
  const clean = (variants || []).map(variant => ({
    id: variant.id,
    quantity: Math.max(0, Number.parseInt(variant.quantity, 10) || 0),
  }));
  if (!clean.some(variant => variant.quantity > 0)) throw new Error('请至少填写一个尺码的本次新增数量');
  const cleanNote = String(note || '').trim().slice(0, 500);
  if (!USE_CLOUD) return api.put(`/factory-inventory/${productId}`, { variants: clean, mode: 'add', note: cleanNote });
  if (navigator.onLine === false) throw new Error('待出货库存录入需要连接云端，请联网后重试');
  blockBackgroundSync();
  const { data, error } = await supabase.rpc('add_factory_inventory', {
    p_product_id: Number(productId),
    p_variant_ids: clean.map(variant => variant.id),
    p_quantities: clean.map(variant => variant.quantity),
    p_note: cleanNote,
  });
  if (error) {
    if (/add_factory_inventory|schema cache|PGRST202/i.test(error.message || '')) throw new Error('数据库增量录入接口尚未部署，请重新执行 factory-inventory-migration.sql');
    throw new Error(error.message || '新增待出货库存失败');
  }
  if (data?.factory) await localDb.upsertFactoryInventory(data.factory);
  if (data?.change) await localDb.upsertProductChange(data.change);
  emitSyncData(['factory_inventory', 'product_changes']);
  return { data: normalizeFactoryItem({ ...data.factory, product: data.product }) };
};

export const transferFactoryInventory = async (productId, variants, operator = '') => {
  assertCanWrite();
  const clean = (variants || []).map(variant => ({ id: variant.id, quantity: Number(variant.quantity) }))
    .filter(variant => Number.isInteger(variant.quantity) && variant.quantity > 0);
  if (!clean.length) throw new Error('请至少填写一个尺码的入库数量');
  if (!USE_CLOUD) return api.post(`/factory-inventory/${productId}/transfer`, { variants: clean, operator });
  if (navigator.onLine === false) throw new Error('待出货转仓库需要连接云端，请联网后重试');
  const clientOperationId = operationId('factory_transfer');
  blockBackgroundSync();
  clean.forEach((_, index) => markLocalRealtimeEcho('stock_movements', 'client_operation_id', `${clientOperationId}_${index + 1}`));
  const { data, error } = await supabase.rpc('transfer_factory_inventory', {
    p_product_id: Number(productId),
    p_variant_ids: clean.map(variant => variant.id),
    p_quantities: clean.map(variant => variant.quantity),
    p_operator: operator || '',
    p_client_operation_id: clientOperationId,
  });
  if (error) {
    if (/transfer_factory_inventory|schema cache|PGRST202/i.test(error.message || '')) throw new Error('数据库待出货功能尚未部署，请先执行 factory-inventory-migration.sql');
    throw new Error(error.message || '待出货商品入库失败');
  }
  if (data?.product) await localDb.upsertProduct(normalizeProduct(data.product));
  if (data?.factory) await localDb.upsertFactoryInventory(data.factory);
  for (const movement of data?.movements || []) await localDb.upsertMovement(movement);
  if (data?.change) await localDb.upsertProductChange(data.change);
  emitSyncData(['products', 'stock_movements', 'factory_inventory', 'product_changes']);
  return { data: {
    ...data,
    product: data?.product ? normalizeProduct(data.product) : null,
    factory: data?.factory ? normalizeFactoryItem({ ...data.factory, product: data.product }) : null,
  } };
};

export const batchStockIn = async (items) => {
  assertCanWrite();
  if (!Array.isArray(items) || items.length === 0) throw new Error('请至少选择一个需要入库的商品尺码');
  if (items.length > 500) throw new Error('单次最多批量入库500个商品尺码');
  const movements = items.map(item => {
    const quantity = Number(item.quantity);
    if (!item.product_id || !item.variant_id) throw new Error('批量入库数据中存在无效的商品尺码');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('入库数量必须是大于0的整数');
    return {
      product_id: item.product_id,
      variant_id: item.variant_id,
      type: 'in',
      quantity,
      reason: item.reason || '',
      operator: item.operator || '',
      client_operation_id: item.client_operation_id || operationId('batch_stock_in'),
    };
  });

  if (!USE_CLOUD) return api.post('/stock/in/batch', { movements });

  // 离线时逐条写入同一幂等队列；联网后仍通过尺码库存 RPC 重放。
  if (navigator.onLine === false) {
    const results = [];
    for (const movement of movements) results.push((await changeStock('in', movement)).data);
    return { data: { success: true, count: results.length, results, queued: true } };
  }

  movements.forEach(item => {
    markLocalRealtimeEcho('stock_movements', 'client_operation_id', item.client_operation_id);
  });

  const { data, error } = await supabase.rpc('apply_variant_stock_in_batch', {
    p_product_ids: movements.map(item => Number(item.product_id)),
    p_variant_ids: movements.map(item => item.variant_id),
    p_quantities: movements.map(item => item.quantity),
    p_reason: movements[0]?.reason || '',
    p_operator: movements[0]?.operator || '',
    p_client_operation_ids: movements.map(item => item.client_operation_id),
  });
  if (error) {
    if (/apply_variant_stock_in_batch|schema cache|PGRST202/i.test(error.message || '')) {
      throw new Error('数据库批量入库接口尚未部署，请先执行 batch-stock-in-migration.sql');
    }
    throw new Error(`批量入库失败，整批数据未写入：${error.message}`);
  }
  const results = Array.isArray(data?.results) ? data.results : [];
  for (const result of results) {
    if (result?.product) await localDb.upsertProduct(normalizeProduct(result.product));
    if (result?.movement) await localDb.upsertMovement(result.movement);
  }
  emitSyncData(['products', 'stock_movements']);
  return { data: { ...data, success: true } };
};

export const getInventory = async () => {
  if (!USE_CLOUD) return api.get('/inventory');
  const compute = (products) => {
    const normalizedProducts = products.map(normalizeProduct);
    const totalStock = normalizedProducts.reduce((s, p) => s + (p.current_stock || 0), 0);
    const lowStockVariants = normalizedProducts.filter(product => !product.stock_alert_disabled).flatMap(product => product.variants
      .filter(variant => (Number(variant.current_stock) || 0) <= Math.max(0, Number(variant.min_stock) || 0))
      .map(variant => ({
        ...variant,
        product_id: product.id,
        product_name: product.name,
        product_image: product.image_path,
        product_unit: product.unit || '个',
      })));
    const lowProductIds = new Set(lowStockVariants.map(item => item.product_id));
    const lowStock = normalizedProducts.filter(product => lowProductIds.has(product.id));
    const categories = new Set(normalizedProducts.map(p => p.category).filter(Boolean));
    return {
      totalProducts: normalizedProducts.length,
      totalStock,
      lowStockCount: lowStockVariants.length,
      categoryCount: categories.size,
      lowStockProducts: lowStock,
      lowStockVariants,
      products: normalizedProducts,
    };
  };

  // 缓存立即展示，云端更新在后台进行。
  const products = (await localDb.getAllProducts()).filter(p => p && p.name);
  requestBackgroundSync();
  return { data: compute(products) };
};

export const getMovements = async (params = {}) => {
  if (!USE_CLOUD) return api.get('/movements', { params });
  const enrich = (list, pmap) => list.map(m => ({
    ...m,
    product_name: m.product_name || pmap[m.product_id]?.name || '已删除商品',
    product_image: m.product_image || pmap[m.product_id]?.image_path || null,
    product_unit: m.product_unit || pmap[m.product_id]?.unit || '个',
  }));

  const local = await localDb.getAllMovements();
  const products = await localDb.getAllProducts();
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  let result = enrich(local, pmap).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (params.type) result = result.filter(m => m.type === params.type);
  const search = String(params.search || '').trim().toLocaleLowerCase('zh-CN');
  if (search) result = result.filter(m => [m.product_name, m.variant_size, m.variant_barcode]
    .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search)));
  // 本地去重（旧数据可能本地随机 id 与云端 id 并存）
  const seen = new Set();
  result = result.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  const total = result.length;
  const pageSize = params.pageSize || 50;
  const from = ((params.page || 1) - 1) * pageSize;
  requestBackgroundSync();
  return { data: { data: result.slice(from, from + pageSize), total } };
};

// Product info changes log
export const getChanges = async (params = {}) => {
  if (!USE_CLOUD) return api.get('/changes', { params });
  const [changes, products] = await Promise.all([
    localDb.getAllProductChanges(),
    localDb.getAllProducts(),
  ]);
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  let result = changes
    .filter(c => !params.product_id || c.product_id === Number(params.product_id))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(c => ({
      ...c,
      product_name: c.product_name || pmap[c.product_id]?.name || '已删除商品',
      product_image: c.product_image || pmap[c.product_id]?.image_path || null,
    }));
  const total = result.length;
  const pageSize = params.pageSize || 50;
  const from = ((params.page || 1) - 1) * pageSize;
  requestBackgroundSync();
  return { data: { data: result.slice(from, from + pageSize), total } };
};

export const getFactoryInventoryHistory = async (params = {}) => {
  if (!USE_CLOUD) return api.get('/factory-inventory/history', { params });
  const [changes, products] = await Promise.all([
    localDb.getAllProductChanges(),
    localDb.getAllProducts(),
  ]);
  const pmap = Object.fromEntries(products.map(product => [product.id, product]));
  const search = String(params.search || '').trim().toLocaleLowerCase('zh-CN');
  let result = changes
    .filter(change => change.field === '待出货库存录入')
    .map(change => ({
      ...change,
      product_name: change.product_name || pmap[change.product_id]?.name || '已删除商品',
      product_image: change.product_image || pmap[change.product_id]?.image_path || null,
    }));
  if (search) result = result.filter(record => [record.product_name, record.old_value, record.new_value, record.note]
    .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search)));
  result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = result.length;
  const pageSize = params.pageSize || 50;
  const from = ((params.page || 1) - 1) * pageSize;
  requestBackgroundSync();
  return { data: { data: result.slice(from, from + pageSize), total } };
};

// 统一变更记录：普通出入库 + 工厂待出货库存变更。
export const getActivityRecords = async (params = {}) => {
  if (!USE_CLOUD) return api.get('/activity', { params });
  const [movements, changes, products] = await Promise.all([
    localDb.getAllMovements(),
    localDb.getAllProductChanges(),
    localDb.getAllProducts(),
  ]);
  const pmap = Object.fromEntries(products.map(product => [product.id, product]));
  const movementRecords = movements.map(movement => ({
    ...movement,
    record_kind: 'movement',
    product_name: movement.product_name || pmap[movement.product_id]?.name || '已删除商品',
    product_image: movement.product_image || pmap[movement.product_id]?.image_path || null,
    product_unit: movement.product_unit || pmap[movement.product_id]?.unit || '个',
  }));
  const factoryRecords = changes
    .filter(change => String(change.field || '').startsWith('待出货'))
    .map(change => ({
      ...change,
      record_kind: 'factory',
      product_name: change.product_name || pmap[change.product_id]?.name || '已删除商品',
      product_image: change.product_image || pmap[change.product_id]?.image_path || null,
      product_unit: pmap[change.product_id]?.unit || '个',
    }));

  let result = params.type === 'factory'
    ? factoryRecords
    : params.type === 'in' || params.type === 'out'
      ? movementRecords.filter(record => record.type === params.type)
      : [...movementRecords, ...factoryRecords];
  const search = String(params.search || '').trim().toLocaleLowerCase('zh-CN');
  if (search) result = result.filter(record => [
    record.product_name, record.variant_size, record.variant_barcode,
    record.field, record.old_value, record.new_value, record.note,
  ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search)));
  result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const seen = new Set();
  result = result.filter(record => {
    const key = `${record.record_kind}_${record.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const total = result.length;
  const pageSize = params.pageSize || 50;
  const from = ((params.page || 1) - 1) * pageSize;
  requestBackgroundSync();
  return { data: { data: result.slice(from, from + pageSize), total } };
};

// 按商品 ID 查询变更记录（商品管理页内预览用）
export const getProductChanges = async (productId) => {
  if (!USE_CLOUD) return api.get(`/products/${productId}/changes`);
  try {
    const local = await localDb.getProductChanges(productId);
    requestBackgroundSync();
    return { data: local };
  } catch {
    return { data: [] };
  }
};

// =============== Tags API ===============

export const getTags = async () => {
  if (!USE_CLOUD) return api.get('/tags');
  const local = (await localDb.getAllTags())
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  requestBackgroundSync();
  return { data: local };
};

export const createTag = async (name, parentId = null) => {
  assertCanWrite();
  if (!USE_CLOUD) return api.post('/tags', { name, parent_id: parentId });
  return writeWithSync('tags', 'insert', { name, parent_id: parentId, created_at: now() });
};

export const deleteTag = async (id) => {
  assertCanWrite();
  if (!USE_CLOUD) return api.delete(`/tags/${id}`);
  // 本地级联删除子标签（云端由 FK ON DELETE CASCADE 完成）
  const all = await localDb.getAllTags();
  for (const child of all.filter(t => t.parent_id === id)) {
    await localDb.deleteTag(child.id);
  }
  await localDb.deleteTag(id);
  return writeWithSync('tags', 'delete', { id });
};

export const getSyncDiagnostics = async () => ({
  status: getSyncStatus(),
  pending: await localDb.getSyncQueue(),
});

// =============== 同步服务 ===============

export { initSync, triggerSync, pushToCloud, pullFromCloud, getSyncStatus, resetAndPull };
export { isSupabaseAvailable } from '../lib/supabase';

export default api;
