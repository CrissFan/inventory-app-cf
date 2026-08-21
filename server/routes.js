import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './db.js';
import { authMiddleware, authRoutes, teamRoutes } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = Router();

const productRow = (row) => {
  if (!row) return row;
  let variants = [];
  try { variants = JSON.parse(row.variants || '[]'); } catch {}
  variants = Array.isArray(variants) ? variants.map(variant => ({
    ...variant,
    current_stock: Number(variant.current_stock) || 0,
    min_stock: Number(variant.min_stock ?? row.min_stock) || 0,
  })) : [];
  return { ...row, barcode: '', variants, stock_alert_disabled: Boolean(row.stock_alert_disabled) };
};

const assertUniqueVariantBarcodes = (teamId, variants, excludeId = null) => {
  const codes = variants.map(v => String(v.barcode || '').trim()).filter(Boolean);
  if (new Set(codes).size !== codes.length) throw new Error('当前商品存在重复条形码');
  const rows = db.prepare('SELECT id, name, variants FROM products WHERE team_id = ?').all(teamId);
  for (const row of rows) {
    if (excludeId && Number(row.id) === Number(excludeId)) continue;
    const other = productRow(row).variants;
    const duplicate = other.find(v => codes.includes(String(v.barcode || '').trim()));
    if (duplicate) throw new Error(`条形码「${duplicate.barcode}」已被商品「${row.name}」占用`);
  }
};

const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
const distUploadsDir = path.join(__dirname, '..', 'dist', 'uploads');
[uploadsDir, distUploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Save to public/uploads/ (primary)
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const filename = `product_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    // Also copy to dist/uploads/ after save, via a small hook
    file._copyTarget = filename;
    cb(null, filename);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('仅支持 jpg/jpeg/png/gif/webp 格式'));
  },
});

// ============ Auth routes (no middleware needed) ============
authRoutes(router);

// ============ Team routes (auth required) ============
teamRoutes(router);

// ============ Products (auth required, scoped by team) ============

router.get('/products', authMiddleware, (req, res) => {
  const { search, category } = req.query;
  let sql = 'SELECT * FROM products WHERE team_id = @team_id';
  const params = { team_id: req.user.team_id };

  if (search) {
    sql += " AND (name LIKE @search OR variants LIKE @search OR category LIKE @search)";
    params.search = `%${search}%`;
  }
  if (category) {
    sql += " AND category = @category";
    params.category = category;
  }
  sql += ' ORDER BY updated_at DESC';

  const rows = db.prepare(sql).all(params).map(productRow);
  res.json(rows);
});

router.get('/products/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?')
    .get(req.params.id, req.user.team_id);
  if (!row) return res.status(404).json({ error: '商品不存在' });
  res.json(productRow(row));
});

router.get('/products/barcode/:barcode', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE team_id = ?').all(req.user.team_id)
    .map(productRow).find(product => product.variants.some(v => v.barcode === req.params.barcode));
  if (!row) return res.status(404).json({ error: '未找到该条形码对应的商品' });
  res.json({ ...row, selected_variant: row.variants.find(v => v.barcode === req.params.barcode) });
});

// 单次请求、单事务批量创建商品及缺失标签。
router.post('/products/batch', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有创建商品权限' });
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  if (!products.length) return res.status(400).json({ error: '请至少提交一个商品' });
  if (products.length > 500) return res.status(400).json({ error: '单次最多创建500个商品' });

  try {
    const createBatch = db.transaction(() => {
      const existingProducts = db.prepare('SELECT name, variants FROM products WHERE team_id = ?').all(req.user.team_id).map(productRow);
      const occupiedBarcodes = new Map();
      for (const product of existingProducts) {
        for (const variant of product.variants || []) {
          const code = String(variant.barcode || '').trim();
          if (code) occupiedBarcodes.set(code, product.name);
        }
      }

      const batchBarcodes = new Set();
      for (const product of products) {
        if (!String(product.name || '').trim()) throw new Error('商品名称不能为空');
        if (!Array.isArray(product.variants) || !product.variants.length) throw new Error(`商品「${product.name}」至少需要一个尺码`);
        const sizes = new Set();
        for (const variant of product.variants) {
          const size = String(variant.size || '').trim();
          const barcode = String(variant.barcode || '').trim();
          const sizeKey = size.toLocaleLowerCase('zh-CN');
          if (!size) throw new Error(`商品「${product.name}」存在未填写的尺码`);
          if (!barcode) throw new Error(`商品「${product.name}」的尺码「${size}」未填写条形码`);
          if (sizes.has(sizeKey)) throw new Error(`商品「${product.name}」存在重复尺码「${size}」`);
          if (batchBarcodes.has(barcode)) throw new Error(`条形码「${barcode}」在本批商品中重复`);
          if (occupiedBarcodes.has(barcode)) throw new Error(`条形码「${barcode}」已被商品「${occupiedBarcodes.get(barcode)}」占用`);
          sizes.add(sizeKey);
          batchBarcodes.add(barcode);
        }
      }

      const findTags = name => db.prepare('SELECT * FROM tags WHERE team_id = ? AND lower(trim(name)) = lower(trim(?)) ORDER BY id').all(req.user.team_id, name);
      const ensureTag = (name, parentId) => {
        const cleanName = String(name || '').trim();
        if (!cleanName) return null;
        const matches = findTags(cleanName);
        if (matches.length > 1) throw new Error(`标签「${cleanName}」已有重复数据，请先整理标签`);
        if (matches.length === 1) {
          const sameParent = (matches[0].parent_id ?? null) === (parentId ?? null);
          if (!sameParent) throw new Error(`标签「${cleanName}」已存在于其他层级，标签内容必须唯一`);
          return matches[0];
        }
        const info = db.prepare('INSERT INTO tags (team_id, parent_id, name) VALUES (?, ?, ?)').run(req.user.team_id, parentId, cleanName);
        return db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid);
      };

      const created = [];
      for (const product of products) {
        const name = String(product.name).trim();
        const category = String(product.category || '').trim();
        const subTags = String(product.sub_tags || '').split(/[,，、；;]+/).map(item => item.trim()).filter(Boolean);
        if (subTags.length && !category) throw new Error(`商品「${name}」填写二级标签时必须同时填写一级标签`);
        let topTag = null;
        if (category) topTag = ensureTag(category, null);
        for (const subTag of subTags) ensureTag(subTag, topTag.id);

        const variants = product.variants.map(variant => ({
          id: String(variant.id || `variant_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`),
          size: String(variant.size).trim(), barcode: String(variant.barcode).trim(), current_stock: 0,
          min_stock: Math.max(0, Number.parseInt(variant.min_stock, 10) || 0),
        }));
        const info = db.prepare(`
          INSERT INTO products (team_id, barcode, variants, name, description, category, sub_tags, unit, image_path, min_stock, stock_alert_disabled, current_stock)
          VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          req.user.team_id, JSON.stringify(variants), name, String(product.description || ''), category,
          subTags.join(','), String(product.unit || '个'), String(product.image_path || ''),
          variants.reduce((sum, variant) => sum + variant.min_stock, 0), product.stock_alert_disabled ? 1 : 0,
        );
        db.prepare('INSERT INTO product_changes (product_id, team_id, user_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
          .run(info.lastInsertRowid, req.user.team_id, req.user.id, '创建商品', '', name);
        created.push(productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid)));
      }
      return created;
    });

    const created = createBatch();
    const tags = db.prepare('SELECT * FROM tags WHERE team_id = ? ORDER BY created_at, id').all(req.user.team_id);
    res.status(201).json({ products: created, created_count: created.length, tags });
  } catch (error) {
    res.status(400).json({ error: error.message || '批量创建失败' });
  }
});

router.post('/products/batch-delete', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有删除商品权限' });
  const productIds = [...new Set((req.body?.product_ids || []).map(Number).filter(Number.isSafeInteger))];
  if (!productIds.length) return res.status(400).json({ error: '请至少选择一个商品' });
  if (productIds.length > 500) return res.status(400).json({ error: '单次最多删除500个商品' });

  try {
    const removeBatch = db.transaction(() => {
      const placeholders = productIds.map(() => '?').join(',');
      const existing = db.prepare(`SELECT id FROM products WHERE team_id = ? AND id IN (${placeholders})`).all(req.user.team_id, ...productIds);
      if (existing.length !== productIds.length) throw new Error('所选商品包含不存在或无权删除的数据，请刷新后重试');
      const result = db.prepare(`DELETE FROM products WHERE team_id = ? AND id IN (${placeholders})`).run(req.user.team_id, ...productIds);
      return result.changes;
    });
    const deletedCount = removeBatch();
    res.json({ deleted_count: deletedCount, product_ids: productIds });
  } catch (error) {
    res.status(400).json({ error: error.message || '批量删除失败' });
  }
});

router.post('/products', authMiddleware, (req, res) => {
  const { name, description, category, sub_tags, unit, image_path, min_stock, stock_alert_disabled, variants = [] } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '商品名称不能为空' });

  try {
    assertUniqueVariantBarcodes(req.user.team_id, variants);
    const info = db.prepare(`
      INSERT INTO products (team_id, barcode, variants, name, description, category, sub_tags, unit, image_path, min_stock, stock_alert_disabled, current_stock)
      VALUES (@team_id, '', @variants, @name, @description, @category, @sub_tags, @unit, @image_path, @min_stock, @stock_alert_disabled, @current_stock)
    `).run({
      team_id: req.user.team_id,
      variants: JSON.stringify(variants.map(v => ({ ...v, current_stock: 0 }))),
      current_stock: 0,
      name: name.trim(),
      description: description || '',
      category: category || '',
      sub_tags: sub_tags || '',
      unit: unit || '个',
      image_path: image_path || '',
      min_stock: min_stock || 0,
      stock_alert_disabled: stock_alert_disabled ? 1 : 0,
    });
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(productRow(product));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/products/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?')
    .get(req.params.id, req.user.team_id);
  if (!existing) return res.status(404).json({ error: '商品不存在' });

  const { name, description, category, sub_tags, unit, image_path, min_stock, stock_alert_disabled, variants } = req.body;

  // Track changed fields
  const changedFields = [];
  const fieldMap = { variants: '尺码规格', name: '商品名称', description: '描述', category: '分类', sub_tags: '二级标签', image_path: '图片', min_stock: '最低库存预警', stock_alert_disabled: '库存预警提醒' };
  for (const [key, label] of Object.entries(fieldMap)) {
    const newVal = req.body[key] !== undefined ? String(req.body[key] ?? '') : String(existing[key] ?? '');
    const oldVal = String(existing[key] ?? '');
    if (newVal !== oldVal) {
      changedFields.push({ field: label, old_value: oldVal, new_value: newVal });
    }
  }

  try {
    const nextVariants = variants || productRow(existing).variants;
    assertUniqueVariantBarcodes(req.user.team_id, nextVariants, req.params.id);
    db.prepare(`
      UPDATE products SET
        barcode = '',
        variants = @variants,
        current_stock = @current_stock,
        name = @name,
        description = @description,
        category = @category,
        sub_tags = @sub_tags,
        unit = @unit,
        image_path = @image_path,
        min_stock = @min_stock,
        stock_alert_disabled = @stock_alert_disabled,
        updated_at = datetime('now', 'localtime')
      WHERE id = @id AND team_id = @team_id
    `).run({
      id: parseInt(req.params.id),
      team_id: req.user.team_id,
      variants: JSON.stringify(nextVariants),
      current_stock: nextVariants.reduce((sum, v) => sum + (Number(v.current_stock) || 0), 0),
      name: name ?? existing.name,
      description: description ?? existing.description,
      category: category ?? existing.category,
      sub_tags: sub_tags ?? existing.sub_tags,
      unit: unit ?? existing.unit,
      image_path: image_path ?? existing.image_path,
      min_stock: min_stock ?? existing.min_stock,
      stock_alert_disabled: stock_alert_disabled === undefined ? existing.stock_alert_disabled : (stock_alert_disabled ? 1 : 0),
    });

    // Log changes
    const insertLog = db.prepare(
      'INSERT INTO product_changes (product_id, team_id, user_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const ch of changedFields) {
      insertLog.run(parseInt(req.params.id), req.user.team_id, req.user.id, ch.field, ch.old_value, ch.new_value);
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(productRow(product));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/products/:id', authMiddleware, (req, res) => {
  const info = db.prepare('DELETE FROM products WHERE id = ? AND team_id = ?')
    .run(req.params.id, req.user.team_id);
  if (info.changes === 0) return res.status(404).json({ error: '商品不存在' });
  res.json({ success: true });
});

// Product changes log (product info edit history)
router.get('/products/:id/changes', authMiddleware, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?')
    .get(req.params.id, req.user.team_id);
  if (!product) return res.status(404).json({ error: '商品不存在' });

  const changes = db.prepare(`
    SELECT c.*, u.display_name as user_name
    FROM product_changes c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.product_id = ?
    ORDER BY c.created_at DESC
    LIMIT 100
  `).all(parseInt(req.params.id));
  res.json(changes);
});

// ============ Image Upload ============

router.post('/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
  // Copy to dist/uploads/ for production serving
  try {
    const srcPath = path.join(uploadsDir, req.file.filename);
    const dstPath = path.join(distUploadsDir, req.file.filename);
    if (fs.existsSync(distUploadsDir)) {
      fs.copyFileSync(srcPath, dstPath);
    }
  } catch (copyErr) {
    // Non-critical — image is still in public/uploads/
    console.warn('Failed to copy image to dist/uploads:', copyErr.message);
  }
  res.json({ path: `/uploads/${req.file.filename}` });
});

// ============ Stock In / Out (auth required) ============

router.post('/stock/in/batch', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有入库权限' });
  const movements = Array.isArray(req.body?.movements) ? req.body.movements : [];
  if (!movements.length) return res.status(400).json({ error: '请至少提交一条入库数据' });
  if (movements.length > 500) return res.status(400).json({ error: '单次最多批量入库500个商品尺码' });

  try {
    const applyBatch = db.transaction(() => {
      const results = [];
      for (const item of movements) {
        const productId = Number(item.product_id);
        const variantId = String(item.variant_id || '');
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(productId) || !variantId) throw new Error('批量入库数据中存在无效的商品尺码');
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('入库数量必须是大于0的整数');
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?').get(productId, req.user.team_id);
        if (!product) throw new Error('商品不存在或不属于当前团队');
        const normalized = productRow(product);
        const variant = normalized.variants.find(value => String(value.id) === variantId);
        if (!variant) throw new Error(`商品「${normalized.name}」中不存在所选尺码`);
        const nextVariants = normalized.variants.map(value => String(value.id) === variantId
          ? { ...value, current_stock: (Number(value.current_stock) || 0) + quantity }
          : value);
        db.prepare('UPDATE products SET variants = ?, current_stock = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
          .run(JSON.stringify(nextVariants), nextVariants.reduce((sum, value) => sum + (Number(value.current_stock) || 0), 0), productId);
        const movementInfo = db.prepare('INSERT INTO stock_movements (product_id, team_id, user_id, type, quantity, reason, operator, variant_id, variant_size, variant_barcode) VALUES (?, ?, ?, \'in\', ?, ?, ?, ?, ?, ?)')
          .run(productId, req.user.team_id, req.user.id, quantity, item.reason || '', item.operator || req.user.display_name, variant.id, variant.size, variant.barcode);
        results.push({
          product: productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(productId)),
          movement: db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(movementInfo.lastInsertRowid),
        });
      }
      return results;
    });
    const results = applyBatch();
    res.json({ success: true, count: results.length, results });
  } catch (error) {
    res.status(400).json({ error: error.message || '批量入库失败，整批数据未写入' });
  }
});

router.post('/stock/in', authMiddleware, (req, res) => {
  const { product_id, variant_id, quantity, reason, operator } = req.body;
  if (!product_id) return res.status(400).json({ error: '请选择商品' });
  if (!quantity || quantity <= 0) return res.status(400).json({ error: '数量必须大于0' });

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?')
    .get(product_id, req.user.team_id);
  if (!product) return res.status(404).json({ error: '商品不存在' });

  const normalized = productRow(product);
  const variant = normalized.variants.find(v => v.id === variant_id);
  if (!variant) return res.status(400).json({ error: '请选择有效尺码' });
  const nextVariants = normalized.variants.map(v => v.id === variant_id ? { ...v, current_stock: (v.current_stock || 0) + Number(quantity) } : v);
  const txn = db.transaction(() => {
    db.prepare('UPDATE products SET variants = ?, current_stock = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(JSON.stringify(nextVariants), nextVariants.reduce((s, v) => s + v.current_stock, 0), product_id);
    db.prepare('INSERT INTO stock_movements (product_id, team_id, user_id, type, quantity, reason, operator, variant_id, variant_size, variant_barcode) VALUES (?, ?, ?, \'in\', ?, ?, ?, ?, ?, ?)')
      .run(product_id, req.user.team_id, req.user.id, quantity, reason || '', operator || req.user.display_name, variant.id, variant.size, variant.barcode);
  });
  txn();

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  res.json({ success: true, product: productRow(updated) });
});

router.post('/stock/out', authMiddleware, (req, res) => {
  const { product_id, variant_id, quantity, reason, operator } = req.body;
  if (!product_id) return res.status(400).json({ error: '请选择商品' });
  if (!quantity || quantity <= 0) return res.status(400).json({ error: '数量必须大于0' });

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?')
    .get(product_id, req.user.team_id);
  if (!product) return res.status(404).json({ error: '商品不存在' });
  const normalized = productRow(product);
  const variant = normalized.variants.find(v => v.id === variant_id);
  if (!variant) return res.status(400).json({ error: '请选择有效尺码' });
  if (variant.current_stock < quantity) return res.status(400).json({ error: `尺码 ${variant.size} 库存不足，当前库存 ${variant.current_stock}` });
  const nextVariants = normalized.variants.map(v => v.id === variant_id ? { ...v, current_stock: v.current_stock - Number(quantity) } : v);

  const txn = db.transaction(() => {
    db.prepare('UPDATE products SET variants = ?, current_stock = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(JSON.stringify(nextVariants), nextVariants.reduce((s, v) => s + v.current_stock, 0), product_id);
    db.prepare('INSERT INTO stock_movements (product_id, team_id, user_id, type, quantity, reason, operator, variant_id, variant_size, variant_barcode) VALUES (?, ?, ?, \'out\', ?, ?, ?, ?, ?, ?)')
      .run(product_id, req.user.team_id, req.user.id, quantity, reason || '', operator || req.user.display_name, variant.id, variant.size, variant.barcode);
  });
  txn();

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  res.json({ success: true, product: productRow(updated) });
});

// ============ Tags / Categories (auth required, scoped by team) ============

router.get('/tags', authMiddleware, (req, res) => {
  const tags = db.prepare('SELECT * FROM tags WHERE team_id = ? ORDER BY name ASC')
    .all(req.user.team_id);
  res.json(tags);
});

router.post('/tags', authMiddleware, (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '标签名称不能为空' });
  try {
    if (parent_id) {
      const parent = db.prepare('SELECT id FROM tags WHERE id = ? AND team_id = ?').get(parent_id, req.user.team_id);
      if (!parent) return res.status(400).json({ error: '父标签不存在' });
    }
    const info = db.prepare('INSERT INTO tags (team_id, name, parent_id) VALUES (?, ?, ?)')
      .run(req.user.team_id, name.trim(), parent_id || null);
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(tag);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '标签名称已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tags/:id', authMiddleware, (req, res) => {
  const info = db.prepare('DELETE FROM tags WHERE id = ? AND team_id = ?')
    .run(req.params.id, req.user.team_id);
  if (info.changes === 0) return res.status(404).json({ error: '标签不存在' });
  res.json({ success: true });
});

// ============ Inventory Overview ============

router.get('/inventory', authMiddleware, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE team_id = ? ORDER BY name ASC').all(req.user.team_id).map(productRow);
  const totalProducts = products.length;
  const totalStock = products.reduce((sum, p) => sum + p.current_stock, 0);
  const lowStockVariants = products.filter(product => !product.stock_alert_disabled).flatMap(product => product.variants
    .filter(variant => (Number(variant.current_stock) || 0) <= Math.max(0, Number(variant.min_stock) || 0))
    .map(variant => ({ ...variant, product_id: product.id, product_name: product.name, product_image: product.image_path, product_unit: product.unit || '个' })));
  const lowIds = new Set(lowStockVariants.map(item => item.product_id));
  const lowStock = products.filter(product => lowIds.has(product.id));
  const categories = [...new Set(products.map(p => p.category).filter(Boolean))];

  res.json({
    totalProducts,
    totalStock,
    lowStockCount: lowStockVariants.length,
    lowStockProducts: lowStock,
    lowStockVariants,
    categories,
    products,
  });
});

// ============ Stock Movements ============

router.get('/movements', authMiddleware, (req, res) => {
  const { product_id, type, search, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize), 200);
  const offset = (parseInt(page) - 1) * limit;

  let sql = `
    SELECT m.*, p.name as product_name, p.barcode as product_barcode, p.unit as product_unit, p.image_path as product_image,
           u.display_name as operator_name
    FROM stock_movements m
    LEFT JOIN products p ON m.product_id = p.id
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.team_id = @team_id
  `;
  const params = { team_id: req.user.team_id };

  if (product_id) {
    sql += ' AND m.product_id = @product_id';
    params.product_id = parseInt(product_id);
  }
  if (type && ['in', 'out'].includes(type)) {
    sql += ' AND m.type = @type';
    params.type = type;
  }
  if (search && search.trim()) {
    sql += " AND (lower(COALESCE(p.name, '')) LIKE lower(@search) OR lower(COALESCE(m.variant_size, '')) LIKE lower(@search) OR lower(COALESCE(m.variant_barcode, '')) LIKE lower(@search))";
    params.search = `%${search.trim()}%`;
  }
  sql += ' ORDER BY m.created_at DESC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(sql).all(params);

  let countSql = 'SELECT COUNT(*) as total FROM stock_movements m LEFT JOIN products p ON m.product_id = p.id WHERE m.team_id = @team_id';
  const countParams = { team_id: req.user.team_id };
  if (product_id) {
    countSql += ' AND m.product_id = @product_id';
    countParams.product_id = parseInt(product_id);
  }
  if (type && ['in', 'out'].includes(type)) {
    countSql += ' AND m.type = @type';
    countParams.type = type;
  }
  if (search && search.trim()) {
    countSql += " AND (lower(COALESCE(p.name, '')) LIKE lower(@search) OR lower(COALESCE(m.variant_size, '')) LIKE lower(@search) OR lower(COALESCE(m.variant_barcode, '')) LIKE lower(@search))";
    countParams.search = `%${search.trim()}%`;
  }
  const { total } = db.prepare(countSql).get(countParams);

  res.json({ data: rows, total, page: parseInt(page), pageSize: limit });
});

// Product changes log — track product info edits
router.get('/changes', authMiddleware, (req, res) => {
  const { product_id, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize), 200);
  const offset = (parseInt(page) - 1) * limit;

  let sql = `
    SELECT c.*, p.name as product_name, p.barcode as product_barcode, p.image_path as product_image,
           u.display_name as user_name
    FROM product_changes c
    LEFT JOIN products p ON c.product_id = p.id
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.team_id = @team_id
  `;
  const params = { team_id: req.user.team_id };

  if (product_id) {
    sql += ' AND c.product_id = @product_id';
    params.product_id = parseInt(product_id);
  }
  sql += ' ORDER BY c.created_at DESC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(sql).all(params);

  let countSql = 'SELECT COUNT(*) as total FROM product_changes c WHERE c.team_id = @team_id';
  const countParams = { team_id: req.user.team_id };
  if (product_id) {
    countSql += ' AND c.product_id = @product_id';
    countParams.product_id = parseInt(product_id);
  }
  const { total } = db.prepare(countSql).get(countParams);

  res.json({ data: rows, total, page: parseInt(page), pageSize: limit });
});

export default router;
