/**
 * Supabase 多端同步引擎。
 * 云端是唯一事实源；IndexedDB 仅用于离线缓存、待同步队列和迁移备份。
 */

import * as localDb from './localDb';
import { getSupabase, isSupabaseAvailable } from './supabase';

let syncRunning = false;
let syncInitialized = false;
let syncTimer = null;
let realtimeChannel = null;
let realtimeDebounce = null;
let lastBackgroundRequest = 0;
let backgroundSyncBlockedUntil = 0;
let pendingRealtimeEvents = [];
const recentLocalEchoes = new Map();

const state = {
  lastSync: null,
  lastError: null,
  pendingCount: 0,
  migrationStatus: 'idle',
  realtimeStatus: 'disconnected',
};

function isOnline() {
  return navigator.onLine !== false;
}

function emitStatus() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:status', { detail: getSyncStatus() }));
  }
}

function emitData(tables, source = 'sync') {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sync:data', { detail: { tables, source } }));
  }
}

export function markLocalRealtimeEcho(table, field, value, ttl = 8000) {
  if (value == null || value === '') return;
  blockBackgroundSync();
  const key = `${table}:${field}:${String(value)}`;
  const current = recentLocalEchoes.get(key);
  recentLocalEchoes.set(key, {
    expiresAt: Date.now() + ttl,
    count: (current?.count || 0) + 1,
  });
}

export function blockBackgroundSync(ttl = 15000) {
  backgroundSyncBlockedUntil = Math.max(backgroundSyncBlockedUntil, Date.now() + ttl);
}

function consumeLocalRealtimeEcho(table, row) {
  const now = Date.now();
  for (const [key, entry] of recentLocalEchoes) {
    if (entry.expiresAt <= now) recentLocalEchoes.delete(key);
  }
  const keys = [
    row?.id != null ? `${table}:id:${String(row.id)}` : null,
    row?.product_id != null ? `${table}:product_id:${String(row.product_id)}` : null,
    row?.client_operation_id ? `${table}:client_operation_id:${String(row.client_operation_id)}` : null,
  ].filter(Boolean);
  const matched = keys.find(key => recentLocalEchoes.has(key));
  if (!matched) return false;
  const entry = recentLocalEchoes.get(matched);
  if (entry.count > 1) recentLocalEchoes.set(matched, { ...entry, count: entry.count - 1 });
  else recentLocalEchoes.delete(matched);
  return true;
}

async function refreshPendingCount() {
  state.pendingCount = await localDb.getSyncQueueCount();
  emitStatus();
}

export async function queueForSync(operation, error = null) {
  await localDb.addToSyncQueue(operation);
  if (error) setError(error);
  await refreshPendingCount();
}

function setError(error) {
  state.lastError = error ? (error.message || String(error)) : null;
  emitStatus();
}

function operationId(prefix = 'op') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

const toBoolean = value => value === true || value === 1 || String(value).trim().toLowerCase() === 'true';

function normalizeProduct(product) {
  const variants = Array.isArray(product.variants) && product.variants.length
    ? product.variants.map(v => ({
        ...v,
        current_stock: Number(v.current_stock) || 0,
        min_stock: Number(v.min_stock ?? product.min_stock) || 0,
      }))
    : [{
        id: `legacy_${product.id}`, size: '默认规格', barcode: product.barcode || '',
        current_stock: Number(product.current_stock) || 0, min_stock: Number(product.min_stock) || 0,
      }];
  return {
    ...product,
    barcode: '',
    variants,
    current_stock: variants.reduce((sum, v) => sum + v.current_stock, 0),
    created_at: product.created_at || product.synced_at || null,
    updated_at: product.updated_at || product.created_at || product.synced_at || null,
    image_path: product.image_path || product.image_url || '',
    stock_alert_disabled: toBoolean(product.stock_alert_disabled),
    status: product.status || 'done',
  };
}

function toCloudProduct(product) {
  const { id, image_path, synced_at, ...rest } = product;
  return { ...rest, barcode: '', image_url: image_path || rest.image_url || '' };
}

function assertResult(result, label) {
  if (result?.error) throw new Error(`${label}：${result.error.message}`);
  return result?.data;
}

export async function resolveCloudContext() {
  if (!isSupabaseAvailable()) return null;
  const supabase = getSupabase();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const user = sessionData?.session?.user;
  if (!user) throw new Error('云端登录已失效，请重新登录');

  let membership;
  const rpcResult = await supabase.rpc('get_current_membership');
  if (!rpcResult.error) {
    membership = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
  } else {
    // 兼容数据库迁移尚未应用的旧环境。
    const fallback = await supabase.from('team_members')
      .select('id,team_id,display_name,role,team:team_id(name,invite_code)')
      .eq('user_id', user.id).maybeSingle();
    if (fallback.error) throw new Error(`无法读取团队身份：${rpcResult.error.message}`);
    if (fallback.data) {
      membership = {
        member_id: fallback.data.id,
        team_id: fallback.data.team_id,
        team_name: fallback.data.team?.name,
        invite_code: fallback.data.team?.invite_code,
        display_name: fallback.data.display_name,
        role: fallback.data.role,
      };
    }
  }

  if (!membership?.team_id) throw new Error('当前账号尚未加入团队');
  await localDb.activateCacheScope(user.id, membership.team_id);
  return { user, membership };
}

async function getTeamId() {
  return localDb.getMeta('team_id');
}

export async function pullFromCloud() {
  if (!isSupabaseAvailable() || !isOnline()) return false;
  const supabase = getSupabase();
  const teamId = await getTeamId();
  if (!teamId) throw new Error('缺少团队信息，无法同步');

  const [productsRes, movementsRes, tagsRes, changesRes, factoryRes] = await Promise.all([
    supabase.from('products').select('*').eq('team_id', teamId).order('updated_at', { ascending: false }),
    supabase.from('stock_movements').select('*').eq('team_id', teamId).order('created_at', { ascending: false }).limit(1000),
    supabase.from('tags').select('*').eq('team_id', teamId).order('created_at', { ascending: true }),
    supabase.from('product_changes').select('*').eq('team_id', teamId).order('created_at', { ascending: false }).limit(1000),
    supabase.from('factory_inventory').select('*').eq('team_id', teamId).order('updated_at', { ascending: false }),
  ]);
  const products = assertResult(productsRes, '拉取商品失败').map(normalizeProduct);
  const movements = assertResult(movementsRes, '拉取流水失败');
  const tags = assertResult(tagsRes, '拉取标签失败');
  const changes = assertResult(changesRes, '拉取变更记录失败');
  const factoryInventory = assertResult(factoryRes, '拉取工厂待出货库存失败');

  // replace 而不是 upsert，确保其他设备删除的数据也会从本地消失。
  await Promise.all([
    localDb.replaceProducts(products),
    localDb.replaceMovements(movements),
    localDb.replaceTags(tags),
    localDb.replaceProductChanges(changes),
    localDb.replaceFactoryInventory(factoryInventory),
  ]);
  state.lastSync = new Date().toISOString();
  state.lastError = null;
  await localDb.setMeta('last_sync', state.lastSync);
  emitStatus();
  emitData(['products', 'stock_movements', 'tags', 'product_changes', 'factory_inventory'], 'full-sync');
  return true;
}

async function applyStockRpc(data, fallbackOperationId) {
  const supabase = getSupabase();
  const clientOperationId = data.client_operation_id || fallbackOperationId || operationId('stock');
  let variantId = data.variant_id;
  if (!variantId) {
    const product = normalizeProduct((await localDb.getProduct(data.product_id)) || {});
    if (product.variants?.length === 1) variantId = product.variants[0].id;
  }
  const result = await supabase.rpc('apply_variant_stock_movement', {
    p_product_id: Number(data.product_id),
    p_variant_id: variantId,
    p_type: data.type,
    p_quantity: Number(data.quantity),
    p_reason: data.reason || '',
    p_operator: data.operator || '',
    p_client_operation_id: clientOperationId,
  });
  const payload = assertResult(result, '云端出入库失败');
  if (payload?.product) await localDb.upsertProduct(normalizeProduct(payload.product));
  if (payload?.movement) await localDb.upsertMovement(payload.movement);
  return payload;
}

async function findExistingProduct(teamId, product) {
  const supabase = getSupabase();
  const barcode = (product.variants || []).map(v => v.barcode).find(Boolean) || '';
  let query = supabase.from('products').select('*').eq('team_id', teamId);
  if (barcode) query = query.contains('variants', [{ barcode }]);
  else query = query.ilike('name', (product.name || '').trim()).eq('category', product.category || '');
  const result = await query.limit(1);
  if (result.error) throw result.error;
  return result.data?.[0] || null;
}

async function pushRegularItem(item, teamId, idMap) {
  const supabase = getSupabase();
  const { table, action } = item;
  const data = { ...item.data };
  if (data.id && idMap[data.id]) data.id = idMap[data.id];
  if (data.product_id && idMap[data.product_id]) data.product_id = idMap[data.product_id];
  if (data.parent_id && idMap[data.parent_id]) data.parent_id = idMap[data.parent_id];

  if (table === 'stock_movements' && action === 'insert') {
    await applyStockRpc(data, `legacy_queue_${teamId}_${item.id}`);
    return;
  }

  if (action === 'insert') {
    let existing = null;
    if (table === 'products') existing = await findExistingProduct(teamId, data);
    if (table === 'tags') {
      let query = supabase.from('tags').select('*').eq('team_id', teamId).eq('name', data.name);
      query = data.parent_id ? query.eq('parent_id', data.parent_id) : query.is('parent_id', null);
      const found = await query.limit(1);
      if (found.error) throw found.error;
      existing = found.data?.[0] || null;
    }
    const insertData = table === 'products' ? toCloudProduct(data) : (() => {
      const { id, synced_at, ...rest } = data;
      return rest;
    })();
    let inserted = existing;
    if (!inserted) {
      const result = await supabase.from(table).insert([{ ...insertData, team_id: teamId }]).select().single();
      inserted = assertResult(result, `上传${table}失败`);
    }
    if (item.localId && inserted?.id) idMap[item.localId] = inserted.id;
    if (table === 'products' && inserted) await localDb.upsertProduct(normalizeProduct(inserted));
    if (table === 'tags' && inserted) await localDb.upsertTag(inserted);
    return;
  }

  if (action === 'update') {
    const { id, synced_at, ...rest } = data;
    if (String(id).startsWith('local_')) throw new Error('本地记录尚未完成云端 ID 映射');
    const updateData = table === 'products' ? toCloudProduct({ ...rest, id }) : rest;
    assertResult(await supabase.from(table).update(updateData).eq('team_id', teamId).eq('id', id).select(), `更新${table}失败`);
    return;
  }

  if (action === 'delete') {
    if (String(data.id).startsWith('local_')) return;
    assertResult(await supabase.from(table).delete().eq('team_id', teamId).eq('id', data.id), `删除${table}失败`);
  }
}

export async function pushToCloud() {
  if (!isSupabaseAvailable() || !isOnline()) return 0;
  const teamId = await getTeamId();
  if (!teamId) throw new Error('缺少团队信息，无法上传');
  const queue = await localDb.getSyncQueue();
  const idMap = (await localDb.getMeta('cloud_id_map')) || {};
  let pushed = 0;

  for (const item of queue) {
    try {
      if (item.action === 'stock_movement') {
        const stockData = {
          ...item.data,
          product_id: idMap[item.data?.product_id] || item.data?.product_id,
        };
        if (String(stockData.product_id).startsWith('local_')) {
          throw new Error('待同步流水关联的商品尚未完成云端 ID 映射');
        }
        await applyStockRpc(stockData, stockData.client_operation_id);
      }
      else await pushRegularItem(item, teamId, idMap);
      await localDb.removeFromSyncQueue(item.id);
      pushed++;
    } catch (error) {
      // 永不静默丢弃。权限、字段或 RPC 错误保留在队列，供修复后重试。
      setError(error);
      await localDb.setMeta('cloud_id_map', idMap);
      await refreshPendingCount();
      throw error;
    }
  }
  await localDb.setMeta('cloud_id_map', idMap);
  await refreshPendingCount();
  return pushed;
}

export async function reconcileLocalToCloud() {
  if (!isSupabaseAvailable() || !isOnline()) return false;
  const supabase = getSupabase();
  const teamId = await getTeamId();
  if (!teamId) throw new Error('缺少团队信息，无法合并历史数据');

  const idMap = (await localDb.getMeta('cloud_id_map')) || {};
  const migrationDone = (await localDb.getMeta('sync_migration_version')) === 1;
  const includeRecord = record => !migrationDone || String(record?.id || '').startsWith('local_');
  const localProducts = (await localDb.getAllProducts()).filter(includeRecord);
  const localTags = (await localDb.getAllTags()).filter(includeRecord);
  const localMovements = (await localDb.getAllMovements()).filter(includeRecord);
  if (!localProducts.length && !localTags.length && !localMovements.length) {
    if (!migrationDone) {
      await localDb.setMeta('sync_migration_version', 1);
      state.migrationStatus = 'complete';
      emitStatus();
    }
    return true;
  }

  state.migrationStatus = 'running';
  emitStatus();
  try {
    if (!migrationDone && !(await localDb.getMeta('migration_backup_v1'))) {
      await localDb.setMeta('migration_backup_v1', {
        created_at: new Date().toISOString(),
        ...(await localDb.getLocalSnapshot()),
      });
    }
    for (const product of localProducts) {
      let cloud = await findExistingProduct(teamId, product);
      if (!cloud) {
        const payload = { ...toCloudProduct(product), current_stock: 0, team_id: teamId };
        cloud = assertResult(await supabase.from('products').insert([payload]).select().single(), '合并商品失败');
      }
      idMap[product.id] = cloud.id;
      await localDb.deleteProduct(product.id);
      await localDb.upsertProduct(normalizeProduct(cloud));
    }

    for (const tag of localTags.filter(t => !t.parent_id)) {
      const item = { table: 'tags', action: 'insert', data: tag, localId: tag.id };
      await pushRegularItem(item, teamId, idMap);
    }
    for (const tag of localTags.filter(t => t.parent_id)) {
      const item = { table: 'tags', action: 'insert', data: { ...tag, parent_id: idMap[tag.parent_id] || tag.parent_id }, localId: tag.id };
      await pushRegularItem(item, teamId, idMap);
    }

    for (const movement of localMovements) {
      const productId = idMap[movement.product_id] || movement.product_id;
      if (String(productId).startsWith('local_')) throw new Error('流水关联的商品尚未完成合并');
      // 首次升级时，数字 ID 的流水通常已来自云端；先按主键、再按完整业务签名查重。
      let existing = null;
      if (!String(movement.id).startsWith('local_')) {
        const byId = await supabase.from('stock_movements').select('*')
          .eq('team_id', teamId).eq('id', movement.id).maybeSingle();
        if (byId.error) throw byId.error;
        existing = byId.data;
      }
      if (!existing && movement.created_at) {
        const bySignature = await supabase.from('stock_movements').select('*')
          .eq('team_id', teamId)
          .eq('product_id', productId)
          .eq('type', movement.type)
          .eq('quantity', movement.quantity)
          .eq('created_at', movement.created_at)
          .limit(1);
        if (bySignature.error) throw bySignature.error;
        existing = bySignature.data?.[0] || null;
      }
      if (existing) {
        if (existing.id !== movement.id) await localDb.deleteMovement(movement.id);
        await localDb.upsertMovement(existing);
        continue;
      }
      const payload = await applyStockRpc(
        { ...movement, product_id: productId },
        movement.client_operation_id || `legacy_${teamId}_${movement.id}`,
      );
      await localDb.deleteMovement(movement.id);
      if (payload?.movement) await localDb.upsertMovement(payload.movement);
    }

    await localDb.setMeta('cloud_id_map', idMap);
    await localDb.setMeta('sync_migration_version', 1);
    state.migrationStatus = 'complete';
    state.lastError = null;
    emitStatus();
    return true;
  } catch (error) {
    state.migrationStatus = 'failed';
    setError(error);
    throw error;
  }
}

async function reconcileInventory() {
  const result = await getSupabase().rpc('recalculate_team_inventory');
  // viewer/member 无权执行对账，不影响普通同步；其他错误需要暴露。
  if (result.error && !/仅管理员/.test(result.error.message || '')) throw result.error;
  return !result.error;
}

export async function fullSync() {
  if (syncRunning || !isOnline() || !isSupabaseAvailable()) return false;
  syncRunning = true;
  emitStatus();
  try {
    await reconcileLocalToCloud();
    await pushToCloud();
    await pullFromCloud();
    return true;
  } catch (error) {
    setError(error);
    return false;
  } finally {
    syncRunning = false;
    await refreshPendingCount();
  }
}

export async function resetAndPull() {
  if (!isSupabaseAvailable() || !isOnline()) return false;
  // fullSync 会在上传成功后用 replace 拉取，避免未上传数据被 clearAll 删除。
  const ok = await fullSync();
  const teamId = await getTeamId();
  const reconcileKey = `inventory_reconcile_version:${teamId || 'unknown'}`;
  const needsReconcile = (await localDb.getMeta(reconcileKey)) !== 1;
  if (ok && needsReconcile && (await localDb.getMeta('sync_migration_version')) === 1) {
    try {
      const reconciled = await reconcileInventory();
      await localDb.setMeta(reconcileKey, 1);
      if (reconciled) await pullFromCloud();
    } catch (error) {
      setError(error);
    }
  }
  return ok;
}

export function triggerSync() {
  if (!isOnline()) return;
  fullSync().catch(setError);
}

// 页面读取缓存时触发的 stale-while-revalidate 刷新。
// 以最后成功同步时间和请求间隔双重限流，避免 sync:data → 页面重载 → 再同步的循环。
export function requestBackgroundSync() {
  if (!isOnline() || !isSupabaseAvailable() || syncRunning) return;
  const current = Date.now();
  if (current < backgroundSyncBlockedUntil) return;
  const lastSuccess = state.lastSync ? new Date(state.lastSync).getTime() : 0;
  if (current - lastBackgroundRequest < 30000 || current - lastSuccess < 30000) return;
  lastBackgroundRequest = current;
  triggerSync();
}

async function applyRealtimeEvent(table, payload) {
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!row) return false;
  const isDelete = payload.eventType === 'DELETE';
  if (table === 'products') {
    if (isDelete) await localDb.deleteProductsWithRelatedData([row.id]);
    else await localDb.upsertProduct(normalizeProduct(row));
  } else if (table === 'tags') {
    if (isDelete) await localDb.deleteTag(row.id);
    else await localDb.upsertTag(row);
  } else if (table === 'stock_movements') {
    if (isDelete) await localDb.deleteMovement(row.id);
    else await localDb.upsertMovement(row);
  } else if (table === 'product_changes') {
    if (isDelete) await localDb.deleteProductChange(row.id);
    else await localDb.upsertProductChange(row);
  } else if (table === 'factory_inventory') {
    if (isDelete) await localDb.deleteFactoryInventory(row.id);
    else await localDb.upsertFactoryInventory(row);
  }
  return consumeLocalRealtimeEcho(table, row);
}

async function flushRealtimeEvents() {
  const events = pendingRealtimeEvents;
  pendingRealtimeEvents = [];
  const changedTables = new Set();
  try {
    for (const { table, payload } of events) {
      const localEcho = await applyRealtimeEvent(table, payload);
      if (!localEcho) changedTables.add(table);
    }
    if (changedTables.size) emitData([...changedTables], 'realtime');
  } catch (error) {
    setError(error);
    triggerSync();
  }
}

function subscribeRealtime(teamId) {
  const supabase = getSupabase();
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase.channel(`inventory:${teamId}`);
  for (const table of ['products', 'tags', 'stock_movements', 'product_changes', 'factory_inventory']) {
    realtimeChannel.on('postgres_changes', {
      event: '*', schema: 'public', table, filter: `team_id=eq.${teamId}`,
    }, payload => {
      pendingRealtimeEvents.push({ table, payload });
      clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(flushRealtimeEvents, 100);
    });
  }
  realtimeChannel.subscribe(status => {
    state.realtimeStatus = status === 'SUBSCRIBED' ? 'connected' : status.toLowerCase();
    emitStatus();
  });
}

export async function initSync() {
  if (typeof window === 'undefined' || syncInitialized || !isSupabaseAvailable()) return;
  syncInitialized = true;
  window.addEventListener('online', triggerSync);
  window.addEventListener('offline', emitStatus);

  try {
    const context = await resolveCloudContext();
    subscribeRealtime(context.membership.team_id);
    await refreshPendingCount();
    if (isOnline()) await resetAndPull();
  } catch (error) {
    setError(error);
  }

  syncTimer = setInterval(triggerSync, 30000);
}

export async function stopSync() {
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', triggerSync);
    window.removeEventListener('offline', emitStatus);
  }
  if (syncTimer) clearInterval(syncTimer);
  if (realtimeDebounce) clearTimeout(realtimeDebounce);
  if (realtimeChannel && isSupabaseAvailable()) await getSupabase().removeChannel(realtimeChannel);
  syncTimer = null;
  realtimeChannel = null;
  pendingRealtimeEvents = [];
  recentLocalEchoes.clear();
  syncInitialized = false;
  state.realtimeStatus = 'disconnected';
}

export function getSyncStatus() {
  return {
    online: isOnline(),
    cloudAvailable: isSupabaseAvailable(),
    syncing: syncRunning,
    lastSync: state.lastSync,
    lastError: state.lastError,
    pendingCount: state.pendingCount,
    migrationStatus: state.migrationStatus,
    realtimeStatus: state.realtimeStatus,
  };
}

export { operationId };
