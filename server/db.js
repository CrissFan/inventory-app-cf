import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = join(dataDir, 'inventory.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create core tables first
db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member', 'viewer')),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    UNIQUE(team_id, username)
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT '',
    unit TEXT DEFAULT '个',
    image_path TEXT DEFAULT '',
    current_stock INTEGER DEFAULT 0,
    min_stock INTEGER DEFAULT 0,
    stock_alert_disabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('doing', 'done')),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('in', 'out')),
    quantity INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    operator TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
`);

// Migrate: add new columns for v2 (team/member support)
try { db.exec('ALTER TABLE products ADD COLUMN team_id INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE stock_movements ADD COLUMN team_id INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE stock_movements ADD COLUMN user_id INTEGER'); } catch {}
try { db.exec("ALTER TABLE products ADD COLUMN sub_tags TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT '[]'"); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN stock_alert_disabled INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'done'"); } catch {}
try { db.exec("ALTER TABLE stock_movements ADD COLUMN variant_id TEXT"); } catch {}
try { db.exec("ALTER TABLE stock_movements ADD COLUMN variant_size TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE stock_movements ADD COLUMN variant_barcode TEXT DEFAULT ''"); } catch {}

// 旧商品无损迁移为一个默认规格。
for (const product of db.prepare("SELECT id, barcode, current_stock, variants FROM products").all()) {
  let variants = [];
  try { variants = JSON.parse(product.variants || '[]'); } catch {}
  if (!Array.isArray(variants) || variants.length === 0) {
    variants = [{
      id: `legacy_${product.id}`,
      size: '默认规格',
      barcode: product.barcode || '',
      current_stock: product.current_stock || 0,
    }];
    db.prepare('UPDATE products SET variants = ?, barcode = ? WHERE id = ?')
      .run(JSON.stringify(variants), '', product.id);
  }
}

// Drop old unique constraint on barcode (team-scoped now)
try { db.exec('DROP INDEX IF EXISTS idx_products_barcode'); } catch {}

// Create indices
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_team ON products(team_id);
  CREATE INDEX IF NOT EXISTS idx_movements_team ON stock_movements(team_id);
  CREATE INDEX IF NOT EXISTS idx_movements_product_id ON stock_movements(product_id);
  CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type);
  CREATE INDEX IF NOT EXISTS idx_movements_created_at ON stock_movements(created_at);
  CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);
`);

// Factory pending inventory — quantities that have not yet entered sellable warehouse stock.
db.exec(`
  CREATE TABLE IF NOT EXISTS factory_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'doing' CHECK(status = 'doing'),
    variants TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE(team_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_factory_inventory_team ON factory_inventory(team_id);
  CREATE INDEX IF NOT EXISTS idx_factory_inventory_product ON factory_inventory(product_id);
`);
// Tags/Categories table — team-scoped custom tags
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    UNIQUE(team_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_tags_team ON tags(team_id);
`);
try { db.exec('ALTER TABLE tags ADD COLUMN parent_id INTEGER REFERENCES tags(id) ON DELETE CASCADE'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id)'); } catch {}

// Product changes log — track every edit to product info
db.exec(`
  CREATE TABLE IF NOT EXISTS product_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    user_id INTEGER,
    field TEXT NOT NULL,
    old_value TEXT DEFAULT '',
    new_value TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_product_changes_product ON product_changes(product_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_product_changes_team ON product_changes(team_id);
`);
try { db.exec("ALTER TABLE product_changes ADD COLUMN note TEXT DEFAULT ''"); } catch {}

// 面辅料库存、商品关联、购买记录和工厂裁数消耗。
db.exec(`
  CREATE TABLE IF NOT EXISTS inventory_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('fabric', 'accessory')),
    name TEXT NOT NULL,
    contact_wechat TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    color_code TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL CHECK(unit IN ('米', '个', '件')),
    current_stock REAL NOT NULL DEFAULT 0 CHECK(current_stock >= 0),
    min_stock REAL NOT NULL DEFAULT 0 CHECK(min_stock >= 0),
    alert_disabled INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    updated_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_materials_team ON inventory_materials(team_id);

  CREATE TABLE IF NOT EXISTS inventory_material_product_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    part TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES inventory_materials(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE(material_id, product_id, part)
  );
  CREATE INDEX IF NOT EXISTS idx_material_links_team ON inventory_material_product_links(team_id);

  CREATE TABLE IF NOT EXISTS material_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    user_id INTEGER,
    user_name TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL CHECK(quantity > 0),
    amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
    purchase_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    client_operation_id TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES inventory_materials(id) ON DELETE CASCADE,
    UNIQUE(team_id, client_operation_id)
  );

  CREATE TABLE IF NOT EXISTS material_consumptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    product_id INTEGER,
    user_id INTEGER,
    user_name TEXT NOT NULL DEFAULT '',
    cut_quantity INTEGER NOT NULL DEFAULT 0 CHECK(cut_quantity >= 0),
    quantity REAL NOT NULL CHECK(quantity > 0),
    consumed_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    client_operation_id TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES inventory_materials(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
    UNIQUE(team_id, client_operation_id)
  );
`);

// 新品计划：阶段进入时间保存在 stage_timestamps JSON 中。
db.exec(`
  CREATE TABLE IF NOT EXISTS new_product_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    product_type TEXT NOT NULL DEFAULT '',
    materials TEXT NOT NULL DEFAULT '[]',
    design_image_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    planned_launch_date TEXT,
    stage TEXT NOT NULL DEFAULT 'pattern' CHECK(stage IN ('pattern', 'sample', 'adjust', 'preview', 'listed')),
    stage_timestamps TEXT NOT NULL DEFAULT '{}',
    assignee_user_id INTEGER,
    assignee_name TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    updated_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_new_product_plans_team ON new_product_plans(team_id);
  CREATE INDEX IF NOT EXISTS idx_new_product_plans_stage ON new_product_plans(team_id, stage);
`);

export default db;
