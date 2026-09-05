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
  return { ...row, barcode: '', variants, stock_alert_disabled: Boolean(row.stock_alert_disabled), status: row.status || 'done' };
};

const factoryRow = (row) => {
  if (!row) return row;
  let variants = [];
  try { variants = JSON.parse(row.factory_variants ?? row.variants ?? '[]'); } catch {}
  variants = Array.isArray(variants) ? variants.map(variant => ({ ...variant, quantity: Math.max(0, Number(variant.quantity) || 0) })) : [];
  const product = productRow({
    id: row.product_id, team_id: row.team_id, name: row.product_name, description: row.product_description,
    category: row.product_category, sub_tags: row.product_sub_tags, unit: row.product_unit,
    image_path: row.product_image, variants: row.product_variants, current_stock: row.product_current_stock,
    min_stock: row.product_min_stock, stock_alert_disabled: row.product_stock_alert_disabled, status: 'done',
    created_at: row.product_created_at, updated_at: row.product_updated_at,
  });
  return {
    id: row.id, team_id: row.team_id, product_id: row.product_id, status: 'doing', variants,
    total_quantity: variants.reduce((sum, variant) => sum + variant.quantity, 0),
    created_at: row.created_at, updated_at: row.updated_at, product,
  };
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

const factoryInventorySelect = `
  SELECT f.id, f.team_id, f.product_id, f.status, f.variants AS factory_variants, f.created_at, f.updated_at,
    p.name AS product_name, p.description AS product_description, p.category AS product_category,
    p.sub_tags AS product_sub_tags, p.unit AS product_unit, p.image_path AS product_image,
    p.variants AS product_variants, p.current_stock AS product_current_stock, p.min_stock AS product_min_stock,
    p.stock_alert_disabled AS product_stock_alert_disabled, p.created_at AS product_created_at, p.updated_at AS product_updated_at
  FROM factory_inventory f JOIN products p ON p.id = f.product_id
`;

const summarizeFactoryVariants = variants => {
  const summary = (variants || [])
    .filter(variant => (Number(variant.quantity) || 0) > 0)
    .map(variant => `${variant.size || '未命名尺码'} ${Number(variant.quantity) || 0}`);
  return summary.length ? summary.join('、') : '无库存';
};

router.get('/factory-inventory', authMiddleware, (req, res) => {
  const rows = db.prepare(`${factoryInventorySelect} WHERE f.team_id = ? ORDER BY f.updated_at DESC`).all(req.user.team_id);
  res.json(rows.map(factoryRow));
});

router.get('/factory-inventory/history', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const search = String(req.query.search || '').trim().toLocaleLowerCase('zh-CN');
  let records = db.prepare(`
    SELECT c.*, p.name AS product_name, p.image_path AS product_image, u.display_name AS user_name
    FROM product_changes c
    LEFT JOIN products p ON c.product_id = p.id
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.team_id = ? AND c.field = '待出货库存录入'
    ORDER BY c.created_at DESC
  `).all(req.user.team_id);
  if (search) records = records.filter(record => [record.product_name, record.old_value, record.new_value, record.note]
    .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search)));
  const total = records.length;
  const offset = (page - 1) * pageSize;
  res.json({ data: records.slice(offset, offset + pageSize), total, page, pageSize });
});

router.put('/factory-inventory/:productId', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有待出货库存编辑权限' });
  const productId = Number(req.params.productId);
  const inputVariants = Array.isArray(req.body?.variants) ? req.body.variants : [];
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?').get(productId, req.user.team_id);
  if (!product) return res.status(404).json({ error: '销售商品不存在' });
  const normalized = productRow(product);
  if (!inputVariants.length) return res.status(400).json({ error: '商品至少需要一个尺码' });
  const quantityMap = new Map();
  for (const input of inputVariants) {
    const id = String(input.id || '');
    const quantity = Number(input.quantity);
    if (!id || !Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ error: '待出货数量必须是非负整数' });
    if (quantityMap.has(id)) return res.status(400).json({ error: '尺码参数不能重复' });
    if (!normalized.variants.some(variant => String(variant.id) === id)) return res.status(400).json({ error: '待出货数据包含无效尺码' });
    quantityMap.set(id, quantity);
  }
  const accumulate = req.body?.mode === 'add';
  const note = accumulate ? String(req.body?.note || '').trim().slice(0, 500) : '';
  const materialConsumptions = accumulate && Array.isArray(req.body?.material_consumptions) ? req.body.material_consumptions : [];
  if (accumulate && ![...quantityMap.values()].some(quantity => quantity > 0)) return res.status(400).json({ error: '请至少填写一个尺码的本次新增数量' });
  if (materialConsumptions.length > 100) return res.status(400).json({ error: '单次最多录入100项面辅料消耗' });
  const existingFactory = db.prepare('SELECT * FROM factory_inventory WHERE product_id = ? AND team_id = ?').get(productId, req.user.team_id);
  let existingVariants = [];
  try { existingVariants = JSON.parse(existingFactory?.variants || '[]'); } catch {}
  const variants = normalized.variants.map(variant => ({
    id: variant.id, size: variant.size || '', barcode: variant.barcode || '',
    quantity: (accumulate ? (Number(existingVariants.find(item => String(item.id) === String(variant.id))?.quantity) || 0) : 0)
      + (quantityMap.get(String(variant.id)) || 0),
  }));
  const addedSummary = normalized.variants
    .filter(variant => (quantityMap.get(String(variant.id)) || 0) > 0)
    .map(variant => `${variant.size || '未命名尺码'} +${quantityMap.get(String(variant.id))}`)
    .join('、');
  try {
    const save = db.transaction(() => {
      const seenMaterialIds = new Set();
      const cutQuantity = [...quantityMap.values()].reduce((sum, quantity) => sum + quantity, 0);
      for (const input of materialConsumptions) {
        const materialId = Number(input.material_id);
        const quantity = Number(input.quantity);
        if (!materialId || !(quantity > 0)) throw new Error('面辅料消耗信息不完整');
        if (seenMaterialIds.has(materialId)) throw new Error('面辅料消耗项不能重复');
        seenMaterialIds.add(materialId);
        const material = db.prepare('SELECT * FROM inventory_materials WHERE id=? AND team_id=?').get(materialId, req.user.team_id);
        if (!material) throw new Error('面辅料不存在');
        const linked = db.prepare('SELECT id FROM inventory_material_product_links WHERE team_id=? AND material_id=? AND product_id=?').get(req.user.team_id, materialId, productId);
        if (!linked) throw new Error(`「${material.name}」尚未关联该商品`);
        if (material.kind === 'accessory' && !Number.isInteger(quantity)) throw new Error(`「${material.name}」的辅料消耗数量必须是整数`);
        if (Number(material.current_stock) < quantity) throw new Error(`「${material.name}」库存不足，当前仅 ${material.current_stock} ${material.unit}`);
        db.prepare("UPDATE inventory_materials SET current_stock=current_stock-?, updated_by=?, updated_at=datetime('now','localtime') WHERE id=?").run(quantity, req.user.id, materialId);
        db.prepare('INSERT INTO material_consumptions(team_id,material_id,product_id,user_id,user_name,cut_quantity,quantity,consumed_at,note) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(req.user.team_id, materialId, productId, req.user.id, req.user.display_name || '', cutQuantity, quantity, new Date().toISOString().slice(0, 10), `待出货录入${note ? `：${note}` : ''}`.slice(0, 500));
      }
      db.prepare(`
        INSERT INTO factory_inventory(team_id, product_id, status, variants) VALUES (?, ?, 'doing', ?)
        ON CONFLICT(team_id, product_id) DO UPDATE SET variants = excluded.variants, updated_at = datetime('now', 'localtime')
      `).run(req.user.team_id, productId, JSON.stringify(variants));
      db.prepare('INSERT INTO product_changes (product_id, team_id, user_id, field, old_value, new_value, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          productId, req.user.team_id, req.user.id,
          accumulate ? '待出货库存录入' : '待出货库存调整',
          accumulate ? `原待出货：${summarizeFactoryVariants(existingVariants)}` : summarizeFactoryVariants(existingVariants),
          accumulate ? `本次录入：${addedSummary}；当前待出货：${summarizeFactoryVariants(variants)}` : summarizeFactoryVariants(variants),
          note,
        );
      return factoryRow(db.prepare(`${factoryInventorySelect} WHERE f.team_id = ? AND f.product_id = ?`).get(req.user.team_id, productId));
    });
    res.json(save());
  } catch (error) {
    res.status(400).json({ error: error.message || '保存待出货库存失败' });
  }
});

router.post('/factory-inventory/:productId/transfer', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有待出货入库权限' });
  const productId = Number(req.params.productId);
  const inputVariants = Array.isArray(req.body?.variants) ? req.body.variants : [];
  try {
    const transfer = db.transaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND team_id = ?').get(productId, req.user.team_id);
      const factory = db.prepare('SELECT * FROM factory_inventory WHERE product_id = ? AND team_id = ?').get(productId, req.user.team_id);
      if (!product) throw new Error('销售商品不存在');
      if (!factory) throw new Error('该商品没有待出货库存');
      const normalized = productRow(product);
      let pending = [];
      try { pending = JSON.parse(factory.variants || '[]'); } catch {}
      const quantityMap = new Map();
      for (const input of inputVariants) {
        const id = String(input.id || '');
        const quantity = Number(input.quantity);
        if (!id || !Number.isInteger(quantity) || quantity <= 0) throw new Error('入库数量必须是大于0的整数');
        if (quantityMap.has(id)) throw new Error('尺码参数不能重复');
        const pendingVariant = pending.find(variant => String(variant.id) === id);
        if (!pendingVariant) throw new Error('待出货商品尺码不存在');
        if ((Number(pendingVariant.quantity) || 0) < quantity) throw new Error(`尺码 ${pendingVariant.size} 待出货数量不足，当前数量 ${pendingVariant.quantity || 0}`);
        quantityMap.set(id, quantity);
      }
      if (!quantityMap.size) throw new Error('请至少填写一个尺码的入库数量');
      const nextProductVariants = normalized.variants.map(variant => ({
        ...variant, current_stock: (Number(variant.current_stock) || 0) + (quantityMap.get(String(variant.id)) || 0),
      }));
      const nextPending = pending.map(variant => ({
        ...variant, quantity: (Number(variant.quantity) || 0) - (quantityMap.get(String(variant.id)) || 0),
      }));
      db.prepare("UPDATE products SET variants = ?, current_stock = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
        .run(JSON.stringify(nextProductVariants), nextProductVariants.reduce((sum, variant) => sum + variant.current_stock, 0), productId);
      db.prepare("UPDATE factory_inventory SET variants = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
        .run(JSON.stringify(nextPending), factory.id);
      const movements = [];
      for (const [variantId, quantity] of quantityMap) {
        const variant = normalized.variants.find(item => String(item.id) === variantId);
        const info = db.prepare("INSERT INTO stock_movements(product_id, team_id, user_id, type, quantity, reason, operator, variant_id, variant_size, variant_barcode) VALUES (?, ?, ?, 'in', ?, '大货入库', ?, ?, ?, ?)")
          .run(productId, req.user.team_id, req.user.id, quantity, req.body.operator || req.user.display_name, variant.id, variant.size, variant.barcode);
        movements.push(db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(info.lastInsertRowid));
      }
      const transferredSummary = [...quantityMap].map(([variantId, quantity]) => {
        const variant = normalized.variants.find(item => String(item.id) === variantId);
        return `${variant?.size || variantId} +${quantity}`;
      }).join('、');
      db.prepare('INSERT INTO product_changes (product_id, team_id, user_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          productId, req.user.team_id, req.user.id, '待出货转销售库存',
          `待出货：${summarizeFactoryVariants(pending)}`,
          `待出货：${summarizeFactoryVariants(nextPending)}；大货入库：${transferredSummary}`,
        );
      const updatedProduct = productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
      const updatedFactory = factoryRow(db.prepare(`${factoryInventorySelect} WHERE f.team_id = ? AND f.product_id = ?`).get(req.user.team_id, productId));
      return { product: updatedProduct, factory: updatedFactory, movements };
    });
    res.json(transfer());
  } catch (error) {
    res.status(400).json({ error: error.message || '待出货商品入库失败' });
  }
});

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

// Unified activity feed: stock movements plus factory pending-inventory changes.
router.get('/activity', authMiddleware, (req, res) => {
  const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const type = String(req.query.type || '');
  const search = String(req.query.search || '').trim().toLocaleLowerCase('zh-CN');

  const movementRecords = db.prepare(`
    SELECT m.*, 'movement' AS record_kind, p.name AS product_name, p.unit AS product_unit,
      p.image_path AS product_image, u.display_name AS operator_name
    FROM stock_movements m
    LEFT JOIN products p ON m.product_id = p.id
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.team_id = ?
  `).all(req.user.team_id);
  const factoryRecords = db.prepare(`
    SELECT c.*, 'factory' AS record_kind, p.name AS product_name, p.unit AS product_unit,
      p.image_path AS product_image, u.display_name AS user_name
    FROM product_changes c
    LEFT JOIN products p ON c.product_id = p.id
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.team_id = ? AND c.field LIKE '待出货%'
  `).all(req.user.team_id);

  let records = type === 'factory'
    ? factoryRecords
    : type === 'in' || type === 'out'
      ? movementRecords.filter(record => record.type === type)
      : [...movementRecords, ...factoryRecords];
  if (search) records = records.filter(record => [
    record.product_name, record.variant_size, record.variant_barcode,
    record.field, record.old_value, record.new_value, record.note,
  ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search)));
  records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const total = records.length;
  const offset = (requestedPage - 1) * pageSize;
  res.json({ data: records.slice(offset, offset + pageSize), total, page: requestedPage, pageSize });
});

// ============ Materials inventory ============

const materialRow = row => row ? ({ ...row, current_stock: Number(row.current_stock) || 0, min_stock: Number(row.min_stock) || 0, alert_disabled: Boolean(row.alert_disabled) }) : row;

router.get('/materials', authMiddleware, (req, res) => {
  const materials = db.prepare('SELECT * FROM inventory_materials WHERE team_id = ? ORDER BY updated_at DESC').all(req.user.team_id).map(materialRow);
  const links = db.prepare(`SELECT l.*, p.name AS product_name, p.image_path AS product_image FROM inventory_material_product_links l LEFT JOIN products p ON p.id = l.product_id WHERE l.team_id = ?`).all(req.user.team_id);
  res.json(materials.map(material => ({ ...material, links: links.filter(link => link.material_id === material.id).map(link => ({ ...link, product: link.product_id ? { id: link.product_id, name: link.product_name, image_path: link.product_image } : null })) })));
});

router.post('/materials/save', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有面辅料编辑权限' });
  const input = req.body || {};
  const kind = String(input.kind || '');
  const unit = String(input.unit || '');
  const name = String(input.name || '').trim();
  const minStock = Number(input.min_stock) || 0;
  const initialStock = Number(input.initial_stock) || 0;
  const links = Array.isArray(input.links) ? input.links : [];
  if (!name) return res.status(400).json({ error: '名称不能为空' });
  if (!['fabric', 'accessory'].includes(kind)) return res.status(400).json({ error: '面辅料类型无效' });
  if ((kind === 'fabric' && unit !== '米') || (kind === 'accessory' && !['个', '件'].includes(unit))) return res.status(400).json({ error: '单位与类型不匹配' });
  if (minStock < 0) return res.status(400).json({ error: '最低库存不能为负数' });
  if (initialStock < 0) return res.status(400).json({ error: '初始库存不能为负数' });
  if (kind === 'accessory' && (!Number.isInteger(minStock) || !Number.isInteger(initialStock))) return res.status(400).json({ error: '辅料库存只能填写整数' });
  try {
    const save = db.transaction(() => {
      let materialId = Number(input.id) || null;
      const values = [kind, name, String(input.contact_wechat || '').trim(), String(input.model || '').trim(), String(input.color_code || '').trim(), unit, minStock, input.alert_disabled ? 1 : 0, String(input.note || '').trim().slice(0, 500), req.user.id];
      if (materialId) {
        const info = db.prepare("UPDATE inventory_materials SET kind=?, name=?, contact_wechat=?, model=?, color_code=?, unit=?, min_stock=?, alert_disabled=?, note=?, updated_by=?, updated_at=datetime('now','localtime') WHERE id=? AND team_id=?").run(...values, materialId, req.user.team_id);
        if (!info.changes) throw new Error('面辅料不存在');
      } else {
        const info = db.prepare('INSERT INTO inventory_materials(kind,name,contact_wechat,model,color_code,unit,current_stock,min_stock,alert_disabled,note,created_by,updated_by,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(kind, name, String(input.contact_wechat || '').trim(), String(input.model || '').trim(), String(input.color_code || '').trim(), unit, initialStock, minStock, input.alert_disabled ? 1 : 0, String(input.note || '').trim().slice(0, 500), req.user.id, req.user.id, req.user.team_id);
        materialId = Number(info.lastInsertRowid);
      }
      db.prepare('DELETE FROM inventory_material_product_links WHERE material_id=? AND team_id=?').run(materialId, req.user.team_id);
      for (const link of links) {
        const productId = Number(link.product_id);
        if (!db.prepare('SELECT id FROM products WHERE id=? AND team_id=?').get(productId, req.user.team_id)) throw new Error('关联商品不存在');
        db.prepare('INSERT OR IGNORE INTO inventory_material_product_links(team_id,material_id,product_id,part) VALUES (?,?,?,?)').run(req.user.team_id, materialId, productId, String(link.part || '').trim().slice(0, 100));
      }
      return {
        material: materialRow(db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(materialId)),
        links: db.prepare('SELECT * FROM inventory_material_product_links WHERE material_id=?').all(materialId),
      };
    });
    res.json(save());
  } catch (error) { res.status(400).json({ error: error.message || '保存面辅料失败' }); }
});

router.post('/materials/:id/purchases', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有购买记录录入权限' });
  const quantity = Number(req.body.quantity); const amount = Number(req.body.amount) || 0;
  if (!(quantity > 0) || amount < 0) return res.status(400).json({ error: '购买数量必须大于0，花费不能为负数' });
  try {
    const save = db.transaction(() => {
      const operationId = String(req.body.client_operation_id || '').trim();
      if (operationId) {
        const previous = db.prepare('SELECT * FROM material_purchases WHERE team_id=? AND client_operation_id=?').get(req.user.team_id, operationId);
        if (previous) return { material: materialRow(db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(previous.material_id)), record: previous, duplicate: true };
      }
      const material = db.prepare('SELECT * FROM inventory_materials WHERE id=? AND team_id=?').get(req.params.id, req.user.team_id);
      if (!material) throw new Error('面辅料不存在');
      if (material.kind === 'accessory' && !Number.isInteger(quantity)) throw new Error('辅料购买数量只能填写整数');
      db.prepare("UPDATE inventory_materials SET current_stock=current_stock+?, updated_by=?, updated_at=datetime('now','localtime') WHERE id=?").run(quantity, req.user.id, material.id);
      const info = db.prepare('INSERT INTO material_purchases(team_id,material_id,user_id,user_name,quantity,amount,purchase_date,note,client_operation_id) VALUES (?,?,?,?,?,?,?,?,?)').run(req.user.team_id, material.id, req.user.id, req.user.display_name || '', quantity, amount, req.body.purchase_date || new Date().toISOString().slice(0, 10), String(req.body.note || '').slice(0, 500), req.body.client_operation_id || null);
      return { material: materialRow(db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(material.id)), record: db.prepare('SELECT * FROM material_purchases WHERE id=?').get(info.lastInsertRowid), duplicate: false };
    });
    res.json(save());
  } catch (error) { res.status(400).json({ error: error.message || '购买入库失败' }); }
});

router.post('/materials/:id/consumptions', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有裁数消耗录入权限' });
  const quantity = Number(req.body.quantity); const cutQuantity = Number(req.body.cut_quantity) || 0; const productId = req.body.product_id ? Number(req.body.product_id) : null;
  if (!(quantity > 0) || !Number.isInteger(cutQuantity) || cutQuantity < 0) return res.status(400).json({ error: '消耗数量必须大于0，工厂裁数不能为负数' });
  try {
    const save = db.transaction(() => {
      const operationId = String(req.body.client_operation_id || '').trim();
      if (operationId) {
        const previous = db.prepare('SELECT * FROM material_consumptions WHERE team_id=? AND client_operation_id=?').get(req.user.team_id, operationId);
        if (previous) return { material: materialRow(db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(previous.material_id)), record: previous, duplicate: true };
      }
      const material = db.prepare('SELECT * FROM inventory_materials WHERE id=? AND team_id=?').get(req.params.id, req.user.team_id);
      if (!material) throw new Error('面辅料不存在');
      if (material.kind === 'accessory' && !Number.isInteger(quantity)) throw new Error('辅料消耗数量只能填写整数');
      if (Number(material.current_stock) < quantity) throw new Error(`库存不足，当前库存 ${material.current_stock} ${material.unit}`);
      if (productId && !db.prepare('SELECT id FROM products WHERE id=? AND team_id=?').get(productId, req.user.team_id)) throw new Error('关联商品不存在');
      db.prepare("UPDATE inventory_materials SET current_stock=current_stock-?, updated_by=?, updated_at=datetime('now','localtime') WHERE id=?").run(quantity, req.user.id, material.id);
      const info = db.prepare('INSERT INTO material_consumptions(team_id,material_id,product_id,user_id,user_name,cut_quantity,quantity,consumed_at,note,client_operation_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.user.team_id, material.id, productId, req.user.id, req.user.display_name || '', cutQuantity, quantity, req.body.consumed_at || new Date().toISOString().slice(0, 10), String(req.body.note || '').slice(0, 500), req.body.client_operation_id || null);
      return { material: materialRow(db.prepare('SELECT * FROM inventory_materials WHERE id=?').get(material.id)), record: db.prepare('SELECT * FROM material_consumptions WHERE id=?').get(info.lastInsertRowid), duplicate: false };
    });
    res.json(save());
  } catch (error) { res.status(400).json({ error: error.message || '裁数消耗失败' }); }
});

router.get('/materials/:id/records', authMiddleware, (req, res) => {
  const material = db.prepare('SELECT id FROM inventory_materials WHERE id=? AND team_id=?').get(req.params.id, req.user.team_id);
  if (!material) return res.status(404).json({ error: '面辅料不存在' });
  const purchases = db.prepare('SELECT * FROM material_purchases WHERE material_id=? AND team_id=? ORDER BY created_at DESC').all(material.id, req.user.team_id);
  const consumptions = db.prepare('SELECT c.*, p.name AS product_name FROM material_consumptions c LEFT JOIN products p ON p.id=c.product_id WHERE c.material_id=? AND c.team_id=? ORDER BY c.created_at DESC').all(material.id, req.user.team_id).map(record => ({ ...record, product: record.product_id ? { id: record.product_id, name: record.product_name } : null }));
  res.json({ purchases, consumptions });
});

// ============ New product plans ============

const newProductPlanRow = row => {
  if (!row) return row;
  let materials = []; let stageTimestamps = {};
  try { materials = JSON.parse(row.materials || '[]'); } catch {}
  try { stageTimestamps = JSON.parse(row.stage_timestamps || '{}'); } catch {}
  return { ...row, materials, stage_timestamps: stageTimestamps };
};

router.get('/new-product-plans', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM new_product_plans WHERE team_id=? ORDER BY updated_at DESC').all(req.user.team_id);
  res.json(rows.map(newProductPlanRow));
});

router.post('/new-product-plans/save', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有新品计划编辑权限' });
  const input = req.body || {};
  const name = String(input.name || '').trim();
  const materialIds = [...new Set((Array.isArray(input.material_ids) ? input.material_ids : []).map(Number).filter(Boolean))];
  if (!name) return res.status(400).json({ error: '商品名称不能为空' });
  try {
    const save = db.transaction(() => {
      const materials = materialIds.map(id => {
        const material = db.prepare("SELECT id,name,model,color_code,unit FROM inventory_materials WHERE id=? AND team_id=? AND kind='fabric'").get(id, req.user.team_id);
        if (!material) throw new Error('选择的面料不存在');
        return material;
      });
      let assignee = null;
      if (input.assignee_user_id) {
        assignee = db.prepare("SELECT id,display_name FROM users WHERE id=? AND team_id=? AND role IN ('admin','member')").get(Number(input.assignee_user_id), req.user.team_id);
        if (!assignee) throw new Error('负责人必须是当前团队的管理员或成员');
      }
      const values = [name, String(input.product_type || '').trim(), JSON.stringify(materials), String(input.design_image_url || ''), String(input.description || '').trim().slice(0, 2000), input.planned_launch_date || null, assignee?.id || null, assignee?.display_name || '', req.user.id];
      let id = Number(input.id) || null;
      if (id) {
        const info = db.prepare("UPDATE new_product_plans SET name=?,product_type=?,materials=?,design_image_url=?,description=?,planned_launch_date=?,assignee_user_id=?,assignee_name=?,updated_by=?,updated_at=datetime('now','localtime') WHERE id=? AND team_id=?").run(...values, id, req.user.team_id);
        if (!info.changes) throw new Error('新品计划不存在');
      } else {
        const now = new Date().toISOString();
        const info = db.prepare('INSERT INTO new_product_plans(team_id,name,product_type,materials,design_image_url,description,planned_launch_date,stage,stage_timestamps,assignee_user_id,assignee_name,created_by,updated_by) VALUES (?,?,?,?,?,?,?,\'pattern\',?,?,?,?,?)')
          .run(req.user.team_id, ...values.slice(0, 6), JSON.stringify({ pattern: now }), assignee?.id || null, assignee?.display_name || '', req.user.id, req.user.id);
        id = Number(info.lastInsertRowid);
      }
      return newProductPlanRow(db.prepare('SELECT * FROM new_product_plans WHERE id=?').get(id));
    });
    res.json(save());
  } catch (error) { res.status(400).json({ error: error.message || '保存新品计划失败' }); }
});

router.post('/new-product-plans/:id/advance', authMiddleware, (req, res) => {
  if (!['admin', 'member'].includes(req.user.role)) return res.status(403).json({ error: '当前账号没有新品进度管理权限' });
  const stages = ['pattern', 'sample', 'adjust', 'preview', 'listed'];
  try {
    const advance = db.transaction(() => {
      const row = db.prepare('SELECT * FROM new_product_plans WHERE id=? AND team_id=?').get(req.params.id, req.user.team_id);
      if (!row) throw new Error('新品计划不存在');
      const currentIndex = stages.indexOf(row.stage);
      const nextStage = String(req.body.next_stage || '');
      if (currentIndex >= stages.length - 1) throw new Error('该商品已上架销售');
      if (nextStage !== stages[currentIndex + 1]) throw new Error('新品阶段必须按顺序推进');
      let timestamps = {};
      try { timestamps = JSON.parse(row.stage_timestamps || '{}'); } catch {}
      timestamps[nextStage] = new Date().toISOString();
      db.prepare("UPDATE new_product_plans SET stage=?,stage_timestamps=?,updated_by=?,updated_at=datetime('now','localtime') WHERE id=?")
        .run(nextStage, JSON.stringify(timestamps), req.user.id, row.id);
      return newProductPlanRow(db.prepare('SELECT * FROM new_product_plans WHERE id=?').get(row.id));
    });
    res.json(advance());
  } catch (error) { res.status(400).json({ error: error.message || '推进新品阶段失败' }); }
});

export default router;
