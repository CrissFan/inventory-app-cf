// Fallback JSON-based database (used if better-sqlite3 fails to compile)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'inventory.json');

let data = { products: [], movements: [], nextProductId: 1, nextMovementId: 1 };

if (fs.existsSync(dbPath)) {
  try {
    data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  } catch (e) {
    console.error('Failed to parse DB file, starting fresh:', e.message);
  }
}

function save() {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

const db = {
  prepare(sql) {
    // Simple query builder for our specific use cases
    return {
      all(params = {}) {
        if (sql.includes('FROM products') && !sql.includes('stock_movements')) {
          let rows = [...data.products];
          if (params.search) {
            const s = params.search.replace(/%/g, '').toLowerCase();
            rows = rows.filter(p =>
              (p.name || '').toLowerCase().includes(s) ||
              (p.barcode || '').toLowerCase().includes(s) ||
              (p.category || '').toLowerCase().includes(s)
            );
          }
          if (params.category) rows = rows.filter(p => p.category === params.category);
          if (sql.includes('ORDER BY updated_at DESC')) rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
          if (sql.includes('ORDER BY name ASC')) rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          return rows;
        }
        if (sql.includes('stock_movements')) {
          let rows = data.movements.map(m => {
            const p = data.products.find(pr => pr.id === m.product_id);
            return { ...m, product_name: p?.name, product_barcode: p?.barcode, product_unit: p?.unit, product_image: p?.image_path };
          });
          if (params.product_id) rows = rows.filter(m => m.product_id === params.product_id);
          if (params.type) rows = rows.filter(m => m.type === params.type);
          if (params.search) {
            const search = String(params.search).replace(/%/g, '').toLowerCase();
            rows = rows.filter(m => [m.product_name, m.variant_size, m.variant_barcode]
              .some(value => String(value || '').toLowerCase().includes(search)));
          }
          rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
          const limit = params.limit || 50;
          const offset = params.offset || 0;
          return rows.slice(offset, offset + limit);
        }
        return [];
      },
      get(params) {
        if (typeof params === 'number' || typeof params === 'string') {
          const id = parseInt(params);
          if (sql.includes('SELECT COUNT')) return { total: data.movements.length };
          if (sql.includes('FROM stock_movements')) return data.movements.find(movement => movement.id === id);
          return data.products.find(p => p.id === id);
        }
        if (sql.includes('SELECT * FROM products WHERE barcode')) {
          return data.products.find(p => p.barcode === params);
        }
        if (sql.includes('SELECT COUNT')) {
          let rows = [...data.movements];
          if (params.product_id) rows = rows.filter(m => m.product_id === params.product_id);
          if (params.type) rows = rows.filter(m => m.type === params.type);
          if (params.search) {
            const search = String(params.search).replace(/%/g, '').toLowerCase();
            rows = rows.filter(m => {
              const product = data.products.find(item => item.id === m.product_id);
              return [product?.name, m.variant_size, m.variant_barcode]
                .some(value => String(value || '').toLowerCase().includes(search));
            });
          }
          return { total: rows.length };
        }
        if (typeof params === 'object') {
          const id = parseInt(params.id);
          return data.products.find(p => p.id === id);
        }
        return null;
      },
      run(...args) {
        const params = args.length === 1 ? args[0] : args;
        if (typeof params === 'number' || typeof params === 'string') {
          const id = parseInt(params);
          if (sql.includes('DELETE FROM products')) {
            const idx = data.products.findIndex(p => p.id === id);
            if (idx >= 0) {
              data.products.splice(idx, 1);
              data.movements = data.movements.filter(m => m.product_id !== id);
              save();
              return { changes: 1 };
            }
            return { changes: 0 };
          }
        }
        if (Array.isArray(params)) {
          // Positional params: .run(quantity, product_id) or .run(product_id, quantity, reason, operator)
          if (sql.includes('UPDATE products SET variants = ?')) {
            const [variants, currentStock, productId] = params;
            const product = data.products.find(item => item.id === productId || item.id === parseInt(productId));
            if (product) {
              product.variants = variants;
              product.current_stock = Number(currentStock) || 0;
              product.updated_at = now();
              save();
              return { changes: 1 };
            }
            return { changes: 0 };
          }
          if (sql.includes('current_stock = current_stock +')) {
            const [qty, pid] = params;
            const p = data.products.find(pr => pr.id === pid || pr.id === parseInt(pid));
            if (p) { p.current_stock += qty; p.updated_at = now(); save(); }
            return { changes: 1 };
          }
          if (sql.includes('current_stock = current_stock -')) {
            const [qty, pid] = params;
            const p = data.products.find(pr => pr.id === pid || pr.id === parseInt(pid));
            if (p) { p.current_stock -= qty; p.updated_at = now(); save(); }
            return { changes: 1 };
          }
          if (sql.includes('INSERT INTO stock_movements')) {
            const isVariantMovement = params.length >= 9;
            const movement = isVariantMovement ? {
              id: data.nextMovementId++, product_id: params[0], team_id: params[1], user_id: params[2],
              type: sql.includes("'out'") ? 'out' : 'in', quantity: params[3], reason: params[4] || '', operator: params[5] || '',
              variant_id: params[6], variant_size: params[7] || '', variant_barcode: params[8] || '', created_at: now(),
            } : {
              id: data.nextMovementId++, product_id: params[0], type: params[1], quantity: params[2],
              reason: params[3] || '', operator: params[4] || '', created_at: now(),
            };
            data.movements.push(movement);
            save();
            return { lastInsertRowid: movement.id };
          }
        }
        if (typeof params === 'object' && !Array.isArray(params)) {
          if (sql.includes('INSERT INTO products')) {
            const product = {
              id: data.nextProductId++,
              barcode: params.barcode || null,
              name: params.name,
              description: params.description || '',
              category: params.category || '',
              unit: params.unit || '个',
              image_path: params.image_path || '',
              current_stock: 0,
              min_stock: params.min_stock || 0,
              stock_alert_disabled: params.stock_alert_disabled ? 1 : 0,
              created_at: now(),
              updated_at: now(),
            };
            data.products.push(product);
            save();
            return { lastInsertRowid: product.id };
          }
          if (sql.includes('UPDATE products SET barcode')) {
            const p = data.products.find(pr => pr.id === params.id);
            if (p) {
              Object.assign(p, {
                barcode: params.barcode, name: params.name, description: params.description,
                category: params.category, unit: params.unit, image_path: params.image_path,
                min_stock: params.min_stock, updated_at: now(),
                stock_alert_disabled: params.stock_alert_disabled ? 1 : 0,
              });
              save();
            }
            return { changes: 1 };
          }
        }
        return { changes: 0 };
      },
    };
  },
  transaction(fn) {
    return (...args) => { const result = fn(...args); save(); return result; };
  },
  exec() {},
  pragma() {},
};

export default db;
