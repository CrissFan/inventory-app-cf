/**
 * 本地 IndexedDB 数据库层
 * 用于离线时本地存储数据，在线时与 Supabase 同步
 */

import { openDB } from 'idb';

const DB_NAME = 'inventory_local';
const DB_VERSION = 3;

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // 商品表
        if (!db.objectStoreNames.contains('products')) {
          const productsStore = db.createObjectStore('products', { keyPath: 'id' });
          productsStore.createIndex('barcode', 'barcode', { unique: false });
          productsStore.createIndex('team_id', 'team_id', { unique: false });
          productsStore.createIndex('synced_at', 'synced_at', { unique: false });
        }

        // 库存流水表
        if (!db.objectStoreNames.contains('stock_movements')) {
          const movementsStore = db.createObjectStore('stock_movements', { keyPath: 'id' });
          movementsStore.createIndex('product_id', 'product_id', { unique: false });
          movementsStore.createIndex('team_id', 'team_id', { unique: false });
          movementsStore.createIndex('created_at', 'created_at', { unique: false });
        }

        // 标签表
        if (!db.objectStoreNames.contains('tags')) {
          const tagsStore = db.createObjectStore('tags', { keyPath: 'id' });
          tagsStore.createIndex('team_id', 'team_id', { unique: false });
        }

        // 同步队列（离线期间待同步的操作）
        if (!db.objectStoreNames.contains('sync_queue')) {
          const queueStore = db.createObjectStore('sync_queue', {
            keyPath: 'id',
            autoIncrement: true,
          });
          queueStore.createIndex('created_at', 'created_at', { unique: false });
        }

        // 元数据（存储 team_id、last_sync 等）
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }

        // 商品变更日志表
        if (!db.objectStoreNames.contains('product_changes')) {
          const changesStore = db.createObjectStore('product_changes', { keyPath: 'id' });
          changesStore.createIndex('product_id', 'product_id', { unique: false });
          changesStore.createIndex('team_id', 'team_id', { unique: false });
          changesStore.createIndex('created_at', 'created_at', { unique: false });
        }

        // 工厂待出货库存缓存。云端仍是唯一事实源，本表用于快速展示和断网读取。
        if (!db.objectStoreNames.contains('factory_inventory')) {
          const factoryStore = db.createObjectStore('factory_inventory', { keyPath: 'id' });
          factoryStore.createIndex('product_id', 'product_id', { unique: false });
          factoryStore.createIndex('team_id', 'team_id', { unique: false });
          factoryStore.createIndex('updated_at', 'updated_at', { unique: false });
        }
      },
    });
  }
  return dbPromise;
}

// =============== 元数据 ===============

export async function getMeta(key) {
  const db = await getDb();
  const record = await db.get('meta', key);
  return record?.value ?? null;
}

export async function setMeta(key, value) {
  const db = await getDb();
  await db.put('meta', { key, value });
}

// =============== 商品 ===============

export async function getAllProducts() {
  const db = await getDb();
  return db.getAll('products');
}

export async function getProduct(id) {
  const db = await getDb();
  return db.get('products', id);
}

export async function getProductByBarcode(barcode) {
  const db = await getDb();
  const code = String(barcode || '').trim();
  const products = await db.getAll('products');
  for (const product of products) {
    const variant = (product.variants || []).find(item => String(item.barcode || '').trim() === code);
    if (variant) return { ...product, selected_variant: variant };
    if (product.barcode && String(product.barcode).trim() === code) return product;
  }
  return null;
}

export async function upsertProduct(product) {
  const db = await getDb();
  await db.put('products', product);
}

export async function upsertProducts(products) {
  const db = await getDb();
  const tx = db.transaction('products', 'readwrite');
  for (const p of products) {
    await tx.store.put(p);
  }
  await tx.done;
}

export async function deleteProducts(ids) {
  const db = await getDb();
  const tx = db.transaction('products', 'readwrite');
  for (const id of ids) await tx.store.delete(id);
  await tx.done;
}

// 删除商品缓存时同步清理其本地流水、变更记录及待同步任务，避免已删除商品被队列重新创建。
export async function deleteProductsWithRelatedData(ids) {
  const db = await getDb();
  const idSet = new Set(ids.map(id => String(id)));
  const tx = db.transaction(['products', 'stock_movements', 'product_changes', 'factory_inventory', 'sync_queue'], 'readwrite');
  for (const id of ids) await tx.objectStore('products').delete(id);

  const movements = await tx.objectStore('stock_movements').getAll();
  for (const movement of movements) {
    if (idSet.has(String(movement.product_id))) await tx.objectStore('stock_movements').delete(movement.id);
  }

  const changes = await tx.objectStore('product_changes').getAll();
  for (const change of changes) {
    if (idSet.has(String(change.product_id))) await tx.objectStore('product_changes').delete(change.id);
  }

  const factoryItems = await tx.objectStore('factory_inventory').getAll();
  for (const item of factoryItems) {
    if (idSet.has(String(item.product_id))) await tx.objectStore('factory_inventory').delete(item.id);
  }

  const queue = await tx.objectStore('sync_queue').getAll();
  for (const item of queue) {
    const relatedIds = [];
    if (item.table === 'products') relatedIds.push(item.localId, item.data?.id);
    if (item.table === 'stock_movements' || item.action === 'stock_movement') relatedIds.push(item.data?.product_id);
    if (relatedIds.some(id => id != null && idSet.has(String(id)))) await tx.objectStore('sync_queue').delete(item.id);
  }
  await tx.done;
}

export async function replaceProducts(products) {
  const db = await getDb();
  const tx = db.transaction('products', 'readwrite');
  await tx.store.clear();
  for (const p of products) await tx.store.put(p);
  await tx.done;
}

export async function deleteProduct(id) {
  const db = await getDb();
  await db.delete('products', id);
}

// =============== 库存流水 ===============

export async function getAllMovements() {
  const db = await getDb();
  return db.getAll('stock_movements');
}

export async function getMovementsByProduct(productId) {
  const db = await getDb();
  return db.getAllFromIndex('stock_movements', 'product_id', productId);
}

export async function upsertMovement(movement) {
  const db = await getDb();
  await db.put('stock_movements', movement);
}

export async function deleteMovement(id) {
  const db = await getDb();
  await db.delete('stock_movements', id);
}

export async function upsertMovements(movements) {
  const db = await getDb();
  const tx = db.transaction('stock_movements', 'readwrite');
  for (const m of movements) {
    await tx.store.put(m);
  }
  await tx.done;
}

export async function replaceMovements(movements) {
  const db = await getDb();
  const tx = db.transaction('stock_movements', 'readwrite');
  await tx.store.clear();
  for (const movement of movements) await tx.store.put(movement);
  await tx.done;
}

// =============== 商品变更日志 ===============

export async function upsertProductChange(change) {
  const db = await getDb();
  const record = change.id
    ? change
    : { ...change, id: `local_change_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` };
  await db.put('product_changes', record);
}

// 按商品 ID 查询变更记录（本地）
export async function getProductChanges(productId) {
  const db = await getDb();
  const all = await db.getAll('product_changes');
  return all
    .filter(c => c.product_id === productId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function getAllProductChanges() {
  const db = await getDb();
  return db.getAll('product_changes');
}

export async function replaceProductChanges(changes) {
  const db = await getDb();
  const tx = db.transaction('product_changes', 'readwrite');
  await tx.store.clear();
  for (const change of changes) await tx.store.put(change);
  await tx.done;
}

// =============== 工厂待出货库存 ===============

export async function getAllFactoryInventory() {
  const db = await getDb();
  return db.getAll('factory_inventory');
}

export async function upsertFactoryInventory(item) {
  if (!item?.id) return;
  const db = await getDb();
  await db.put('factory_inventory', item);
}

export async function replaceFactoryInventory(items) {
  const db = await getDb();
  const tx = db.transaction('factory_inventory', 'readwrite');
  await tx.store.clear();
  for (const item of items) await tx.store.put(item);
  await tx.done;
}

// =============== 标签 ===============

export async function getAllTags() {
  const db = await getDb();
  return db.getAll('tags');
}

export async function upsertTag(tag) {
  const db = await getDb();
  await db.put('tags', tag);
}

export async function upsertTags(tags) {
  const db = await getDb();
  const tx = db.transaction('tags', 'readwrite');
  for (const t of tags) {
    await tx.store.put(t);
  }
  await tx.done;
}

export async function replaceTags(tags) {
  const db = await getDb();
  const tx = db.transaction('tags', 'readwrite');
  await tx.store.clear();
  for (const tag of tags) await tx.store.put(tag);
  await tx.done;
}

export async function deleteTag(id) {
  const db = await getDb();
  await db.delete('tags', id);
}

// =============== 同步队列 ===============

export async function addToSyncQueue(op) {
  const db = await getDb();
  await db.add('sync_queue', {
    ...op,
    created_at: new Date().toISOString(),
    retries: 0,
  });
}

export async function getSyncQueue() {
  const db = await getDb();
  return db.getAll('sync_queue');
}

export async function removeFromSyncQueue(id) {
  const db = await getDb();
  await db.delete('sync_queue', id);
}

export async function clearSyncQueue() {
  const db = await getDb();
  await db.clear('sync_queue');
}

export async function getSyncQueueCount() {
  const db = await getDb();
  return db.count('sync_queue');
}

// 激活当前用户/团队的缓存空间。切换账号前把旧数据快照保存在 meta，
// 然后清空业务表，避免同一浏览器串用上一个账号的数据。
export async function activateCacheScope(userId, teamId) {
  const scope = userId && teamId ? `${userId}:${teamId}` : null;
  if (!scope) throw new Error('无法建立本地缓存空间：缺少用户或团队信息');

  const current = await getMeta('cache_scope');
  if (current === scope) {
    await setMeta('team_id', teamId);
    return false;
  }

  if (current) {
    const snapshot = await getLocalSnapshot();
    await setMeta(`backup:${current}`, {
      created_at: new Date().toISOString(),
      ...snapshot,
    });
    await clearAll();
  }
  // legacy 数据库没有 cache_scope，视为当前首次升级设备的数据，保留供迁移合并。
  await setMeta('cache_scope', scope);
  await setMeta('team_id', teamId);
  return true;
}

export async function getLocalSnapshot() {
  const db = await getDb();
  const [products, movements, tags, productChanges, factoryInventory, syncQueue] = await Promise.all([
    db.getAll('products'),
    db.getAll('stock_movements'),
    db.getAll('tags'),
    db.getAll('product_changes'),
    db.getAll('factory_inventory'),
    db.getAll('sync_queue'),
  ]);
  return { products, movements, tags, productChanges, factoryInventory, syncQueue };
}

// =============== 批量清空 ===============

export async function clearAll() {
  const db = await getDb();
  await db.clear('products');
  await db.clear('stock_movements');
  await db.clear('tags');
  await db.clear('product_changes');
  await db.clear('factory_inventory');
  await db.clear('sync_queue');
}
