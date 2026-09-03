-- ===================================================================
-- 库存管理系统 - Supabase 数据库迁移脚本
-- 在 Supabase SQL Editor 中执行此脚本即可完成初始化
-- ===================================================================

-- 1. 团队表
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. 团队成员表（关联 Supabase Auth users）
CREATE TABLE IF NOT EXISTS team_members (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id) -- 一个用户只能属于一个团队
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- 3. 商品表
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  barcode TEXT DEFAULT '',
  variants JSONB NOT NULL DEFAULT '[]'::JSONB,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  current_stock INTEGER DEFAULT 0,
  min_stock INTEGER DEFAULT 0,
  stock_alert_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('doing', 'done')),
  sub_tags TEXT DEFAULT '',
  -- 同步时间戳
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_team ON products(team_id);

-- 兼容已经创建过 products 表的环境。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_alert_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_status_check' AND conrelid = 'products'::regclass) THEN
    ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('doing', 'done'));
  END IF;
END $$;

-- 工厂待出货库存：商品主档仍唯一，doing 数量独立于销售库存 done。
CREATE TABLE IF NOT EXISTS factory_inventory (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'doing' CHECK (status = 'doing'),
  variants JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_factory_inventory_team ON factory_inventory(team_id);
CREATE INDEX IF NOT EXISTS idx_factory_inventory_product ON factory_inventory(product_id);

-- 4. 库存流水表
CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  type TEXT NOT NULL CHECK (type IN ('in', 'out')),
  quantity INTEGER NOT NULL,
  reason TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  client_operation_id TEXT,
  variant_id TEXT,
  variant_size TEXT DEFAULT '',
  variant_barcode TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movements_team ON stock_movements(team_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_operation_unique
  ON stock_movements(team_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

-- 5. 商品标签表（支持一级/二级层级）
CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_id BIGINT REFERENCES tags(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tags_team ON tags(team_id);
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
-- 一级标签（parent_id 为 NULL）在团队内名称唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_top_unique ON tags(team_id, name) WHERE parent_id IS NULL;
-- 二级标签（有 parent_id）在 (团队, 父级) 下名称唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_sub_unique ON tags(team_id, name, parent_id) WHERE parent_id IS NOT NULL;

-- 6. 商品变更日志表
CREATE TABLE IF NOT EXISTS product_changes (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  user_name TEXT DEFAULT '',
  action TEXT NOT NULL DEFAULT 'update' CHECK (action IN ('create', 'update', 'delete')),
  field TEXT NOT NULL,
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT '',
  product_name TEXT DEFAULT '',
  product_image TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_changes_team ON product_changes(team_id);
CREATE INDEX IF NOT EXISTS idx_product_changes_product ON product_changes(product_id);
CREATE INDEX IF NOT EXISTS idx_product_changes_created ON product_changes(created_at DESC);
-- 兼容早期版本中已经存在但字段不完整的 product_changes 表。
ALTER TABLE product_changes
  ADD COLUMN IF NOT EXISTS user_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'update' CHECK (action IN ('create', 'update', 'delete')),
  ADD COLUMN IF NOT EXISTS product_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_image TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT now();

-- ===================================================================
-- 辅助函数
-- ===================================================================

-- 获取当前用户所属团队 ID
CREATE OR REPLACE FUNCTION get_my_team_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT team_id FROM team_members WHERE user_id = auth.uid() LIMIT 1;
$$;

-- 获取当前用户角色
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT role FROM team_members WHERE user_id = auth.uid() LIMIT 1;
$$;

-- 安全获取当前登录用户的团队关系，避免客户端复用其他账号的本地 team_id
CREATE OR REPLACE FUNCTION get_current_membership()
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, member_id BIGINT, display_name TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.team_id, t.name, t.invite_code, tm.id, tm.display_name, tm.role
  FROM team_members tm
  JOIN teams t ON t.id = tm.team_id
  WHERE tm.user_id = auth.uid()
  LIMIT 1;
$$;

-- 新用户创建团队的引导入口。直接 INSERT 会被 RLS 拦截，因此必须经由受控 RPC。
CREATE OR REPLACE FUNCTION create_team_for_current_user(p_name TEXT, p_display_name TEXT DEFAULT '')
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_team teams%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = v_user) THEN
    RAISE EXCEPTION '当前用户已经加入团队';
  END IF;

  INSERT INTO teams(name, invite_code)
  VALUES (COALESCE(NULLIF(BTRIM(p_name), ''), '我的团队'),
          'INV_' || UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 8)))
  RETURNING * INTO v_team;

  INSERT INTO team_members(team_id, user_id, display_name, role)
  VALUES (v_team.id, v_user, COALESCE(NULLIF(BTRIM(p_display_name), ''), '管理员'), 'admin');

  RETURN QUERY SELECT v_team.id, v_team.name, v_team.invite_code, 'admin'::TEXT;
END;
$$;

-- 未加入团队的用户通过邀请码建立首条成员关系。
CREATE OR REPLACE FUNCTION join_team_by_invite(p_invite_code TEXT, p_display_name TEXT DEFAULT '')
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_team teams%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = v_user) THEN
    RAISE EXCEPTION '当前用户已经加入团队';
  END IF;

  SELECT t.* INTO v_team FROM teams AS t
  WHERE UPPER(t.invite_code) = UPPER(BTRIM(p_invite_code))
  LIMIT 1;
  IF v_team.id IS NULL THEN RAISE EXCEPTION '邀请码无效'; END IF;

  INSERT INTO team_members(team_id, user_id, display_name, role)
  VALUES (v_team.id, v_user, COALESCE(NULLIF(BTRIM(p_display_name), ''), '成员'), 'member');

  RETURN QUERY SELECT v_team.id, v_team.name, v_team.invite_code, 'member'::TEXT;
END;
$$;

-- 原子出入库：行锁 + 库存校验 + 幂等流水，防止多端并发和重复重放。
CREATE OR REPLACE FUNCTION apply_stock_movement(
  p_product_id BIGINT,
  p_type TEXT,
  p_quantity INTEGER,
  p_reason TEXT DEFAULT '',
  p_operator TEXT DEFAULT '',
  p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_team_id UUID;
  v_role TEXT;
  v_product products%ROWTYPE;
  v_movement stock_movements%ROWTYPE;
BEGIN
  SELECT tm.team_id, tm.role INTO v_team_id, v_role
  FROM team_members tm WHERE tm.user_id = v_user LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION '无出入库权限';
  END IF;
  IF p_type NOT IN ('in', 'out') THEN RAISE EXCEPTION '无效的出入库类型'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION '数量必须大于0'; END IF;

  IF p_client_operation_id IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements
    WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_movement.id IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = v_movement.product_id;
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', true);
    END IF;
  END IF;

  SELECT * INTO v_product FROM products
  WHERE id = p_product_id AND team_id = v_team_id
  FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '商品不存在'; END IF;
  IF p_client_operation_id IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements
    WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_movement.id IS NOT NULL THEN
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', true);
    END IF;
  END IF;
  IF p_type = 'out' AND v_product.current_stock < p_quantity THEN
    RAISE EXCEPTION '库存不足，当前库存 %', v_product.current_stock;
  END IF;

  UPDATE products
  SET current_stock = current_stock + CASE WHEN p_type = 'in' THEN p_quantity ELSE -p_quantity END
  WHERE id = v_product.id
  RETURNING * INTO v_product;

  INSERT INTO stock_movements(team_id, product_id, user_id, type, quantity, reason, operator, client_operation_id)
  VALUES (v_team_id, v_product.id, v_user, p_type, p_quantity, COALESCE(p_reason, ''), COALESCE(p_operator, ''), p_client_operation_id)
  RETURNING * INTO v_movement;

  RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', false);
END;
$$;

-- 历史数据合并完成后，以完整流水重新计算库存。仅团队管理员可执行。
CREATE OR REPLACE FUNCTION recalculate_team_inventory()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id UUID;
  v_role TEXT;
  v_count INTEGER;
BEGIN
  SELECT team_id, role INTO v_team_id, v_role FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role <> 'admin' THEN RAISE EXCEPTION '仅管理员可执行库存对账'; END IF;

  UPDATE products p SET current_stock = GREATEST(0, COALESCE((
    SELECT SUM(CASE WHEN m.type = 'in' THEN m.quantity ELSE -m.quantity END)
    FROM stock_movements m WHERE m.product_id = p.id AND m.team_id = v_team_id
  ), 0)) WHERE p.team_id = v_team_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ===================================================================
-- RLS 策略：确保团队数据隔离
-- ===================================================================

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "changes_read" ON product_changes
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "changes_insert" ON product_changes
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

CREATE POLICY "factory_inventory_read" ON factory_inventory
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "factory_inventory_insert" ON factory_inventory
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "factory_inventory_update" ON factory_inventory
  FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "factory_inventory_delete" ON factory_inventory
  FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

-- Teams: 成员可读，管理员可更新
CREATE POLICY "team_read" ON teams
  FOR SELECT USING (id = get_my_team_id());
CREATE POLICY "team_update_admin" ON teams
  FOR UPDATE USING (EXISTS (SELECT 1 FROM team_members WHERE team_id = teams.id AND user_id = auth.uid() AND role = 'admin'));

-- Team Members: 同团队成员可读，管理员可增删改
CREATE POLICY "members_read" ON team_members
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "members_insert_admin" ON team_members
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND EXISTS (SELECT 1 FROM team_members WHERE team_id = team_members.team_id AND user_id = auth.uid() AND role = 'admin'));
CREATE POLICY "members_update_admin" ON team_members
  FOR UPDATE USING (EXISTS (SELECT 1 FROM team_members WHERE team_id = team_members.team_id AND user_id = auth.uid() AND role = 'admin'));
CREATE POLICY "members_delete_admin" ON team_members
  FOR DELETE USING (EXISTS (SELECT 1 FROM team_members WHERE team_id = team_members.team_id AND user_id = auth.uid() AND role = 'admin'));

-- Products: 团队成员可读写（viewer 只读）
CREATE POLICY "products_read" ON products
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "products_insert" ON products
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "products_update" ON products
  FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "products_delete" ON products
  FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() = 'admin');

-- Stock Movements: 团队成员可读写
CREATE POLICY "movements_read" ON stock_movements
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "movements_insert" ON stock_movements
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "movements_update" ON stock_movements
  FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() = 'admin');
CREATE POLICY "movements_delete" ON stock_movements
  FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() = 'admin');

-- Tags: 团队成员可读写
CREATE POLICY "tags_read" ON tags
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "tags_insert" ON tags
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "tags_delete" ON tags
  FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

-- ===================================================================
-- 触发器：自动更新 updated_at
-- ===================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_products_updated_at ON products;
CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- 近实时跨端同步（重复执行时忽略已加入 publication 的表）
ALTER TABLE products REPLICA IDENTITY FULL;
ALTER TABLE tags REPLICA IDENTITY FULL;
ALTER TABLE stock_movements REPLICA IDENTITY FULL;
ALTER TABLE product_changes REPLICA IDENTITY FULL;
ALTER TABLE factory_inventory REPLICA IDENTITY FULL;
DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['products', 'tags', 'stock_movements', 'product_changes', 'factory_inventory'] LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', v_table);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'supabase_realtime publication 不存在，请在 Supabase 控制台启用 Realtime';
END $$;

REVOKE ALL ON FUNCTION get_current_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION create_team_for_current_user(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION join_team_by_invite(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_stock_movement(BIGINT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION recalculate_team_inventory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_current_membership() TO authenticated;
GRANT EXECUTE ON FUNCTION create_team_for_current_user(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION join_team_by_invite(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION apply_stock_movement(BIGINT, TEXT, INTEGER, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION recalculate_team_inventory() TO authenticated;

-- ===================================================================
-- 商品尺码规格：校验、独立库存与新版原子出入库
-- ===================================================================
CREATE OR REPLACE FUNCTION validate_product_variants()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_variant JSONB; v_barcode TEXT;
BEGIN
  IF jsonb_typeof(NEW.variants) <> 'array' OR jsonb_array_length(NEW.variants) = 0 THEN
    IF BTRIM(COALESCE(NEW.barcode, '')) <> '' THEN
      NEW.variants := jsonb_build_array(jsonb_build_object(
        'id', 'legacy_' || COALESCE(NEW.id::TEXT, REPLACE(gen_random_uuid()::TEXT, '-', '')),
        'size', '默认规格', 'barcode', BTRIM(NEW.barcode),
        'current_stock', GREATEST(0, COALESCE(NEW.current_stock, 0)),
        'min_stock', GREATEST(0, COALESCE(NEW.min_stock, 0))
      ));
    ELSE RAISE EXCEPTION '商品至少需要一个尺码规格'; END IF;
  ELSIF TG_OP = 'UPDATE' AND BTRIM(COALESCE(NEW.barcode, '')) <> ''
    AND NEW.barcode IS DISTINCT FROM OLD.barcode AND jsonb_array_length(NEW.variants) = 1 THEN
    NEW.variants := jsonb_set(NEW.variants, '{0,barcode}', to_jsonb(BTRIM(NEW.barcode)));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.team_id::TEXT, 0));
  FOR v_variant IN SELECT value FROM jsonb_array_elements(NEW.variants) LOOP
    IF BTRIM(COALESCE(v_variant->>'id', '')) = '' THEN RAISE EXCEPTION '规格缺少 ID'; END IF;
    IF BTRIM(COALESCE(v_variant->>'size', '')) = '' THEN RAISE EXCEPTION '尺码不能为空'; END IF;
    IF COALESCE((v_variant->>'current_stock')::INTEGER, 0) < 0 THEN RAISE EXCEPTION '规格库存不能为负数'; END IF;
    IF COALESCE((v_variant->>'min_stock')::INTEGER, 0) < 0 THEN RAISE EXCEPTION '尺码预警值不能为负数'; END IF;
    v_barcode := BTRIM(COALESCE(v_variant->>'barcode', ''));
    IF v_barcode <> '' THEN
      IF (SELECT COUNT(*) FROM jsonb_array_elements(NEW.variants) item WHERE BTRIM(COALESCE(item->>'barcode', '')) = v_barcode) > 1
        THEN RAISE EXCEPTION '条形码 % 在当前商品中重复', v_barcode; END IF;
      IF EXISTS (
        SELECT 1 FROM products product, jsonb_array_elements(product.variants) item
        WHERE product.team_id = NEW.team_id AND product.id IS DISTINCT FROM NEW.id
          AND BTRIM(COALESCE(item->>'barcode', '')) = v_barcode
      ) THEN RAISE EXCEPTION '条形码 % 已被其他商品尺码占用', v_barcode; END IF;
    END IF;
  END LOOP;
  NEW.barcode := '';
  NEW.current_stock := COALESCE((SELECT SUM(COALESCE((item->>'current_stock')::INTEGER, 0)) FROM jsonb_array_elements(NEW.variants) item), 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_products_variants ON products;
CREATE TRIGGER validate_products_variants BEFORE INSERT OR UPDATE OF variants, barcode ON products
  FOR EACH ROW EXECUTE FUNCTION validate_product_variants();

CREATE OR REPLACE FUNCTION apply_variant_stock_movement(
  p_product_id BIGINT, p_variant_id TEXT, p_type TEXT, p_quantity INTEGER,
  p_reason TEXT DEFAULT '', p_operator TEXT DEFAULT '', p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user UUID := auth.uid(); v_team_id UUID; v_role TEXT;
  v_product products%ROWTYPE; v_movement stock_movements%ROWTYPE;
  v_variant JSONB; v_variants JSONB; v_stock INTEGER;
BEGIN
  SELECT member.team_id, member.role INTO v_team_id, v_role FROM team_members member WHERE member.user_id = v_user LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无出入库权限'; END IF;
  IF p_type NOT IN ('in', 'out') THEN RAISE EXCEPTION '无效的出入库类型'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION '数量必须大于0'; END IF;
  IF BTRIM(COALESCE(p_variant_id, '')) = '' THEN RAISE EXCEPTION '请选择商品尺码'; END IF;
  IF p_client_operation_id IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_movement.id IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = v_movement.product_id;
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', true);
    END IF;
  END IF;
  SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '商品不存在'; END IF;
  SELECT value INTO v_variant FROM jsonb_array_elements(v_product.variants) WHERE value->>'id' = p_variant_id LIMIT 1;
  IF v_variant IS NULL THEN RAISE EXCEPTION '商品尺码不存在'; END IF;
  v_stock := COALESCE((v_variant->>'current_stock')::INTEGER, 0);
  IF p_type = 'out' AND v_stock < p_quantity THEN RAISE EXCEPTION '尺码 % 库存不足，当前库存 %', v_variant->>'size', v_stock; END IF;
  SELECT jsonb_agg(CASE WHEN item->>'id' = p_variant_id
    THEN jsonb_set(item, '{current_stock}', to_jsonb(v_stock + CASE WHEN p_type = 'in' THEN p_quantity ELSE -p_quantity END))
    ELSE item END) INTO v_variants FROM jsonb_array_elements(v_product.variants) item;
  UPDATE products SET variants = v_variants WHERE id = v_product.id RETURNING * INTO v_product;
  INSERT INTO stock_movements(team_id, product_id, user_id, type, quantity, reason, operator, client_operation_id, variant_id, variant_size, variant_barcode)
  VALUES (v_team_id, v_product.id, v_user, p_type, p_quantity, COALESCE(p_reason, ''), COALESCE(p_operator, ''),
    p_client_operation_id, p_variant_id, COALESCE(v_variant->>'size', ''), COALESCE(v_variant->>'barcode', '')) RETURNING * INTO v_movement;
  RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', false);
END;
$$;

REVOKE ALL ON FUNCTION apply_variant_stock_movement(BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_variant_stock_movement(BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) TO authenticated;

-- 批量尺码出入库：单次 RPC、同一事务，任一条失败则整批回滚。
CREATE OR REPLACE FUNCTION apply_variant_stock_movements(p_movements JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_result JSONB;
  v_results JSONB := '[]'::JSONB;
  v_count INTEGER;
BEGIN
  IF p_movements IS NULL OR jsonb_typeof(p_movements) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '批量出入库参数必须是数组';
  END IF;
  v_count := jsonb_array_length(p_movements);
  IF v_count = 0 THEN RAISE EXCEPTION '请至少提交一条出入库数据'; END IF;
  IF v_count > 500 THEN RAISE EXCEPTION '单次最多提交500条出入库数据'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_movements) LOOP
    v_result := apply_variant_stock_movement(
      (v_item->>'product_id')::BIGINT,
      v_item->>'variant_id',
      COALESCE(v_item->>'type', 'in'),
      (v_item->>'quantity')::INTEGER,
      COALESCE(v_item->>'reason', ''),
      COALESCE(v_item->>'operator', ''),
      NULLIF(v_item->>'client_operation_id', '')
    );
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;

  RETURN jsonb_build_object('count', v_count, 'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION apply_variant_stock_movements(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_variant_stock_movements(JSONB) TO authenticated;

-- 批量入库兼容接口：使用 PostgreSQL 原生数组参数，避免 PostgREST 的 JSONB 入参解析差异。
CREATE OR REPLACE FUNCTION apply_variant_stock_in_batch(
  p_product_ids BIGINT[],
  p_variant_ids TEXT[],
  p_quantities INTEGER[],
  p_reason TEXT DEFAULT '',
  p_operator TEXT DEFAULT '',
  p_client_operation_ids TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_index INTEGER;
  v_count INTEGER;
  v_result JSONB;
  v_results JSONB := jsonb_build_array();
  v_operation_id TEXT;
BEGIN
  v_count := COALESCE(cardinality(p_product_ids), 0);
  IF v_count = 0 THEN RAISE EXCEPTION '请至少提交一条入库数据'; END IF;
  IF v_count > 500 THEN RAISE EXCEPTION '单次最多提交500条入库数据'; END IF;
  IF cardinality(p_variant_ids) IS DISTINCT FROM v_count
    OR cardinality(p_quantities) IS DISTINCT FROM v_count
    OR (p_client_operation_ids IS NOT NULL AND cardinality(p_client_operation_ids) IS DISTINCT FROM v_count)
  THEN RAISE EXCEPTION '批量入库参数数量不一致'; END IF;

  FOR v_index IN 1..v_count LOOP
    v_operation_id := CASE WHEN p_client_operation_ids IS NULL THEN NULL ELSE NULLIF(p_client_operation_ids[v_index], '') END;
    v_result := apply_variant_stock_movement(
      p_product_ids[v_index],
      p_variant_ids[v_index],
      'in',
      p_quantities[v_index],
      COALESCE(p_reason, ''),
      COALESCE(p_operator, ''),
      v_operation_id
    );
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;

  RETURN jsonb_build_object('count', v_count, 'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION apply_variant_stock_in_batch(BIGINT[], TEXT[], INTEGER[], TEXT, TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_variant_stock_in_batch(BIGINT[], TEXT[], INTEGER[], TEXT, TEXT, TEXT[]) TO authenticated;

-- 旧客户端仅可继续操作单规格商品。
CREATE OR REPLACE FUNCTION apply_stock_movement(
  p_product_id BIGINT, p_type TEXT, p_quantity INTEGER, p_reason TEXT DEFAULT '',
  p_operator TEXT DEFAULT '', p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_variants JSONB; v_variant_id TEXT;
BEGIN
  SELECT variants INTO v_variants FROM products WHERE id = p_product_id AND team_id = get_my_team_id();
  IF v_variants IS NULL THEN RAISE EXCEPTION '商品不存在'; END IF;
  IF jsonb_array_length(v_variants) <> 1 THEN RAISE EXCEPTION '该商品包含多个尺码，请升级客户端后操作'; END IF;
  v_variant_id := v_variants->0->>'id';
  RETURN apply_variant_stock_movement(p_product_id, v_variant_id, p_type, p_quantity, p_reason, p_operator, p_client_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION recalculate_team_inventory()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_team_id UUID; v_role TEXT; v_count INTEGER;
BEGIN
  SELECT team_id, role INTO v_team_id, v_role FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role <> 'admin' THEN RAISE EXCEPTION '仅管理员可执行库存对账'; END IF;
  UPDATE products product SET variants = (
    SELECT jsonb_agg(jsonb_set(variant, '{current_stock}', to_jsonb(GREATEST(0, COALESCE((
      SELECT SUM(CASE WHEN movement.type = 'in' THEN movement.quantity ELSE -movement.quantity END)
      FROM stock_movements movement WHERE movement.team_id = v_team_id
        AND movement.product_id = product.id AND movement.variant_id = variant->>'id'
    ), 0))))) FROM jsonb_array_elements(product.variants) variant
  ) WHERE product.team_id = v_team_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ===================================================================
-- 批量创建商品：单次 RPC、单事务写入标签、商品和变更记录
-- ===================================================================
-- 批量创建商品：一次 RPC、一个事务完成标签补建、商品与变更记录插入。
CREATE OR REPLACE FUNCTION batch_create_products(p_products JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_team_id UUID;
  v_role TEXT;
  v_display_name TEXT;
  v_product JSONB;
  v_variant JSONB;
  v_variants JSONB;
  v_inserted products%ROWTYPE;
  v_results JSONB := '[]'::JSONB;
  v_tags JSONB := '[]'::JSONB;
  v_name TEXT;
  v_category TEXT;
  v_sub_tags TEXT;
  v_sub_name TEXT;
  v_size TEXT;
  v_barcode TEXT;
  v_seen_sizes TEXT[];
  v_seen_barcodes TEXT[] := ARRAY[]::TEXT[];
  v_top_id BIGINT;
  v_tag_id BIGINT;
  v_tag_parent BIGINT;
  v_tag_count INTEGER;
  v_created_count INTEGER := 0;
  v_tags_created INTEGER := 0;
  v_min_stock INTEGER;
BEGIN
  SELECT member.team_id, member.role, member.display_name
    INTO v_team_id, v_role, v_display_name
  FROM team_members member
  WHERE member.user_id = v_user_id
  LIMIT 1;

  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION '当前账号没有批量创建商品权限';
  END IF;
  IF p_products IS NULL OR jsonb_typeof(p_products) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '批量商品参数必须是数组';
  END IF;
  IF jsonb_array_length(p_products) = 0 THEN
    RAISE EXCEPTION '请至少提交一个商品';
  END IF;
  IF jsonb_array_length(p_products) > 500 THEN
    RAISE EXCEPTION '单次最多创建500个商品';
  END IF;

  -- 同一团队的商品写入串行化，避免并发批次绕过 JSONB 条形码查重。
  PERFORM pg_advisory_xact_lock(hashtextextended(v_team_id::TEXT, 0));

  -- 整批预校验；任何错误都会回滚整个 RPC。
  FOR v_product IN SELECT value FROM jsonb_array_elements(p_products) LOOP
    v_name := BTRIM(COALESCE(v_product->>'name', ''));
    IF v_name = '' THEN RAISE EXCEPTION '商品名称不能为空'; END IF;
    IF jsonb_typeof(v_product->'variants') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION '商品“%”的尺码数据格式错误', v_name;
    END IF;
    IF jsonb_array_length(v_product->'variants') = 0 THEN
      RAISE EXCEPTION '商品“%”至少需要一个尺码', v_name;
    END IF;

    v_seen_sizes := ARRAY[]::TEXT[];
    FOR v_variant IN SELECT value FROM jsonb_array_elements(v_product->'variants') LOOP
      v_size := BTRIM(COALESCE(v_variant->>'size', ''));
      v_barcode := BTRIM(COALESCE(v_variant->>'barcode', ''));
      IF v_size = '' THEN RAISE EXCEPTION '商品“%”存在未填写的尺码', v_name; END IF;
      IF v_barcode = '' THEN RAISE EXCEPTION '商品“%”的尺码“%”未填写条形码', v_name, v_size; END IF;
      IF LOWER(v_size) = ANY(v_seen_sizes) THEN RAISE EXCEPTION '商品“%”存在重复尺码“%”', v_name, v_size; END IF;
      IF v_barcode = ANY(v_seen_barcodes) THEN RAISE EXCEPTION '条形码“%”在本批商品中重复', v_barcode; END IF;
      IF EXISTS (
        SELECT 1
        FROM products product
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(product.variants, '[]'::JSONB)) item
        WHERE product.team_id = v_team_id
          AND BTRIM(COALESCE(item->>'barcode', '')) = v_barcode
      ) THEN
        RAISE EXCEPTION '条形码“%”已被现有商品占用', v_barcode;
      END IF;
      v_seen_sizes := array_append(v_seen_sizes, LOWER(v_size));
      v_seen_barcodes := array_append(v_seen_barcodes, v_barcode);
    END LOOP;
  END LOOP;

  FOR v_product IN SELECT value FROM jsonb_array_elements(p_products) LOOP
    v_name := BTRIM(v_product->>'name');
    v_category := BTRIM(COALESCE(v_product->>'category', ''));
    v_sub_tags := BTRIM(COALESCE(v_product->>'sub_tags', ''));

    IF v_sub_tags <> '' AND v_category = '' THEN
      RAISE EXCEPTION '商品“%”填写二级标签时必须同时填写一级标签', v_name;
    END IF;

    v_top_id := NULL;
    IF v_category <> '' THEN
      SELECT COUNT(*), MAX(id) FILTER (WHERE parent_id IS NULL)
        INTO v_tag_count, v_top_id
      FROM tags
      WHERE team_id = v_team_id AND LOWER(BTRIM(name)) = LOWER(v_category);

      IF v_tag_count > 1 THEN
        RAISE EXCEPTION '标签“%”已有重复数据，请先整理标签', v_category;
      ELSIF v_tag_count = 1 AND v_top_id IS NULL THEN
        RAISE EXCEPTION '标签“%”已存在于其他层级，标签内容必须唯一', v_category;
      ELSIF v_tag_count = 0 THEN
        INSERT INTO tags(team_id, parent_id, name)
        VALUES (v_team_id, NULL, v_category)
        RETURNING id INTO v_top_id;
        v_tags_created := v_tags_created + 1;
      END IF;
    END IF;

    IF v_sub_tags <> '' THEN
      FOR v_sub_name IN
        SELECT BTRIM(value)
        FROM regexp_split_to_table(v_sub_tags, '[,，、；;]+') AS split_value(value)
        WHERE BTRIM(value) <> ''
      LOOP
        SELECT COUNT(*), MAX(id), MAX(parent_id)
          INTO v_tag_count, v_tag_id, v_tag_parent
        FROM tags
        WHERE team_id = v_team_id AND LOWER(BTRIM(name)) = LOWER(v_sub_name);

        IF v_tag_count > 1 THEN
          RAISE EXCEPTION '标签“%”已有重复数据，请先整理标签', v_sub_name;
        ELSIF v_tag_count = 1 AND v_tag_parent IS DISTINCT FROM v_top_id THEN
          RAISE EXCEPTION '标签“%”已存在于其他层级，标签内容必须唯一', v_sub_name;
        ELSIF v_tag_count = 0 THEN
          INSERT INTO tags(team_id, parent_id, name)
          VALUES (v_team_id, v_top_id, v_sub_name);
          v_tags_created := v_tags_created + 1;
        END IF;
      END LOOP;
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
      'id', COALESCE(NULLIF(BTRIM(item->>'id'), ''), gen_random_uuid()::TEXT),
      'size', BTRIM(item->>'size'),
      'barcode', BTRIM(item->>'barcode'),
      'current_stock', 0,
      'min_stock', CASE
        WHEN COALESCE(item->>'min_stock', '') ~ '^[0-9]+$' THEN (item->>'min_stock')::INTEGER
        ELSE 0
      END
    ) ORDER BY ordinal)
    INTO v_variants
    FROM jsonb_array_elements(v_product->'variants') WITH ORDINALITY AS variant(item, ordinal);

    SELECT COALESCE(SUM((item->>'min_stock')::INTEGER), 0)
      INTO v_min_stock
    FROM jsonb_array_elements(v_variants) item;

    INSERT INTO products(
      team_id, barcode, variants, name, description, category, sub_tags,
      image_url, current_stock, min_stock, stock_alert_disabled, created_at, updated_at, synced_at
    )
    VALUES (
      v_team_id, '', v_variants, v_name, COALESCE(v_product->>'description', ''),
      v_category, v_sub_tags, COALESCE(v_product->>'image_url', ''),
      0, v_min_stock, COALESCE((v_product->>'stock_alert_disabled')::BOOLEAN, FALSE), now(), now(), now()
    )
    RETURNING * INTO v_inserted;

    INSERT INTO product_changes(
      team_id, product_id, user_id, user_name, action, field,
      old_value, new_value, product_name, product_image, created_at, synced_at
    )
    VALUES (
      v_team_id, v_inserted.id, v_user_id, COALESCE(v_display_name, ''),
      'create', '创建商品', '', v_name, v_name, COALESCE(v_product->>'image_url', ''), now(), now()
    );

    v_results := v_results || jsonb_build_array(to_jsonb(v_inserted));
    v_created_count := v_created_count + 1;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(tag_row) ORDER BY tag_row.created_at, tag_row.id), '[]'::JSONB)
    INTO v_tags
  FROM tags tag_row
  WHERE tag_row.team_id = v_team_id;

  RETURN jsonb_build_object(
    'products', v_results,
    'created_count', v_created_count,
    'tags_created', v_tags_created,
    'tags', v_tags
  );
END;
$$;

REVOKE ALL ON FUNCTION batch_create_products(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_create_products(JSONB) TO authenticated;


-- ===================================================================
-- 批量删除商品：单次 RPC、单事务删除
-- ===================================================================
-- 单次 RPC、单事务批量删除商品；商品流水由外键级联删除，图片保留以支持复用。
DROP FUNCTION IF EXISTS batch_delete_products(BIGINT[]);

CREATE OR REPLACE FUNCTION batch_delete_products(p_product_ids JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_team_id UUID;
  v_role TEXT;
  v_display_name TEXT;
  v_ids BIGINT[];
  v_found_count INTEGER;
  v_deleted_count INTEGER;
BEGIN
  SELECT member.team_id, member.role, member.display_name
    INTO v_team_id, v_role, v_display_name
  FROM team_members member
  WHERE member.user_id = v_user_id
  LIMIT 1;

  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION '当前账号没有批量删除商品权限';
  END IF;

  IF p_product_ids IS NULL OR jsonb_typeof(p_product_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '批量删除参数必须是数组';
  END IF;

  BEGIN
    SELECT ARRAY(
      SELECT DISTINCT value::BIGINT
      FROM jsonb_array_elements_text(p_product_ids) AS item(value)
      WHERE BTRIM(value) <> ''
    ) INTO v_ids;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION '商品 ID 格式错误，请刷新后重试';
  END;

  IF COALESCE(cardinality(v_ids), 0) = 0 THEN
    RAISE EXCEPTION '请至少选择一个商品';
  END IF;
  IF cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION '单次最多删除500个商品';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_team_id::TEXT, 0));
  PERFORM 1
  FROM products
  WHERE team_id = v_team_id AND id = ANY(v_ids)
  FOR UPDATE;

  SELECT COUNT(*) INTO v_found_count
  FROM products
  WHERE team_id = v_team_id AND id = ANY(v_ids);

  IF v_found_count <> cardinality(v_ids) THEN
    RAISE EXCEPTION '所选商品包含不存在或无权删除的数据，请刷新后重试';
  END IF;

  INSERT INTO product_changes(
    team_id, product_id, user_id, user_name, action, field,
    old_value, new_value, product_name, product_image, created_at, synced_at
  )
  SELECT
    v_team_id, product.id, v_user_id, COALESCE(v_display_name, ''),
    'delete', '删除商品', product.name, '', product.name, COALESCE(product.image_url, ''), now(), now()
  FROM products product
  WHERE product.team_id = v_team_id AND product.id = ANY(v_ids);

  DELETE FROM products
  WHERE team_id = v_team_id AND id = ANY(v_ids);
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_count', v_deleted_count,
    'product_ids', to_jsonb(v_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION batch_delete_products(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_delete_products(JSONB) TO authenticated;

-- 工厂待出货数量录入。
CREATE OR REPLACE FUNCTION set_factory_inventory(p_product_id BIGINT, p_variant_ids TEXT[], p_quantities INTEGER[])
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID; v_role TEXT; v_user_name TEXT; v_product products%ROWTYPE;
  v_existing factory_inventory%ROWTYPE; v_variants JSONB; v_record factory_inventory%ROWTYPE;
  v_change product_changes%ROWTYPE; v_count INTEGER; v_old_summary TEXT; v_new_summary TEXT;
BEGIN
  SELECT member.team_id, member.role, member.display_name INTO v_team_id, v_role, v_user_name FROM team_members member WHERE member.user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无待出货库存编辑权限'; END IF;
  v_count := COALESCE(cardinality(p_variant_ids), 0);
  IF v_count = 0 OR cardinality(p_quantities) IS DISTINCT FROM v_count THEN RAISE EXCEPTION '尺码与数量参数不完整'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity < 0) THEN RAISE EXCEPTION '待出货数量不能为负数'; END IF;
  IF (SELECT COUNT(DISTINCT input.value) FROM unnest(p_variant_ids) AS input(value)) <> v_count THEN RAISE EXCEPTION '尺码参数不能重复'; END IF;
  SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id AND status = 'done' FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '销售商品不存在'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_variant_ids) AS input(id)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_product.variants) variant WHERE variant->>'id' = input.id)
  ) THEN RAISE EXCEPTION '待出货数据包含无效尺码'; END IF;
  SELECT * INTO v_existing FROM factory_inventory WHERE team_id = v_team_id AND product_id = v_product.id FOR UPDATE;
  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_old_summary
  FROM jsonb_array_elements(COALESCE(v_existing.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;
  SELECT jsonb_agg(jsonb_build_object(
    'id', variant->>'id', 'size', COALESCE(variant->>'size', ''), 'barcode', COALESCE(variant->>'barcode', ''),
    'quantity', COALESCE((SELECT p_quantities[position] FROM generate_subscripts(p_variant_ids, 1) position WHERE p_variant_ids[position] = variant->>'id' LIMIT 1), 0)
  )) INTO v_variants FROM jsonb_array_elements(v_product.variants) variant;
  INSERT INTO factory_inventory(team_id, product_id, status, variants)
  VALUES (v_team_id, v_product.id, 'doing', COALESCE(v_variants, '[]'::JSONB))
  ON CONFLICT (team_id, product_id) DO UPDATE SET variants = EXCLUDED.variants, updated_at = now()
  RETURNING * INTO v_record;
  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_new_summary
  FROM jsonb_array_elements(COALESCE(v_record.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;
  INSERT INTO product_changes(
    team_id, product_id, user_id, user_name, action, field,
    old_value, new_value, product_name, product_image, created_at, synced_at
  ) VALUES (
    v_team_id, v_product.id, auth.uid(), COALESCE(v_user_name, ''), 'update', '待出货库存调整',
    v_old_summary, v_new_summary, v_product.name, COALESCE(v_product.image_url, ''), now(), now()
  ) RETURNING * INTO v_change;
  RETURN jsonb_build_object('factory', to_jsonb(v_record), 'product', to_jsonb(v_product), 'change', to_jsonb(v_change));
END;
$$;

-- 重复录入采用增量合并，不覆盖已有 doing 数量。
DROP FUNCTION IF EXISTS add_factory_inventory(BIGINT, TEXT[], INTEGER[]);
CREATE OR REPLACE FUNCTION add_factory_inventory(p_product_id BIGINT, p_variant_ids TEXT[], p_quantities INTEGER[], p_note TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID; v_role TEXT; v_user_name TEXT; v_product products%ROWTYPE; v_existing factory_inventory%ROWTYPE;
  v_variants JSONB; v_record factory_inventory%ROWTYPE; v_change product_changes%ROWTYPE;
  v_count INTEGER; v_old_summary TEXT; v_new_summary TEXT; v_added_summary TEXT;
BEGIN
  SELECT member.team_id, member.role, member.display_name INTO v_team_id, v_role, v_user_name FROM team_members member WHERE member.user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无待出货库存录入权限'; END IF;
  v_count := COALESCE(cardinality(p_variant_ids), 0);
  IF v_count = 0 OR cardinality(p_quantities) IS DISTINCT FROM v_count THEN RAISE EXCEPTION '尺码与数量参数不完整'; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity > 0) THEN RAISE EXCEPTION '请至少填写一个尺码的本次新增数量'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity < 0) THEN RAISE EXCEPTION '本次新增数量不能为负数'; END IF;
  IF (SELECT COUNT(DISTINCT input.value) FROM unnest(p_variant_ids) AS input(value)) <> v_count THEN RAISE EXCEPTION '尺码参数不能重复'; END IF;
  SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id AND status = 'done' FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '销售商品不存在'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_variant_ids) AS input(id)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_product.variants) variant WHERE variant->>'id' = input.id)
  ) THEN RAISE EXCEPTION '待出货数据包含无效尺码'; END IF;
  SELECT * INTO v_existing FROM factory_inventory WHERE team_id = v_team_id AND product_id = v_product.id FOR UPDATE;
  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_old_summary
  FROM jsonb_array_elements(COALESCE(v_existing.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;
  SELECT jsonb_agg(jsonb_build_object(
    'id', variant->>'id', 'size', COALESCE(variant->>'size', ''), 'barcode', COALESCE(variant->>'barcode', ''),
    'quantity',
      COALESCE((SELECT (existing_variant->>'quantity')::INTEGER FROM jsonb_array_elements(COALESCE(v_existing.variants, '[]'::JSONB)) existing_variant WHERE existing_variant->>'id' = variant->>'id' LIMIT 1), 0)
      + COALESCE((SELECT p_quantities[position] FROM generate_subscripts(p_variant_ids, 1) position WHERE p_variant_ids[position] = variant->>'id' LIMIT 1), 0)
  )) INTO v_variants FROM jsonb_array_elements(v_product.variants) variant;
  INSERT INTO factory_inventory(team_id, product_id, status, variants)
  VALUES (v_team_id, v_product.id, 'doing', COALESCE(v_variants, '[]'::JSONB))
  ON CONFLICT (team_id, product_id) DO UPDATE SET variants = EXCLUDED.variants, updated_at = now()
  RETURNING * INTO v_record;
  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_new_summary
  FROM jsonb_array_elements(COALESCE(v_record.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;
  SELECT COALESCE(string_agg(
    format('%s +%s', COALESCE((
      SELECT variant->>'size' FROM jsonb_array_elements(v_product.variants) variant
      WHERE variant->>'id' = p_variant_ids[position] LIMIT 1
    ), p_variant_ids[position]), p_quantities[position]),
    '、' ORDER BY position
  ), '无') INTO v_added_summary
  FROM generate_subscripts(p_variant_ids, 1) position
  WHERE p_quantities[position] > 0;
  INSERT INTO product_changes(
    team_id, product_id, user_id, user_name, action, field,
    old_value, new_value, product_name, product_image, note, created_at, synced_at
  ) VALUES (
    v_team_id, v_product.id, auth.uid(), COALESCE(v_user_name, ''), 'update', '待出货库存录入',
    format('原待出货：%s', v_old_summary), format('本次录入：%s；当前待出货：%s', v_added_summary, v_new_summary),
    v_product.name, COALESCE(v_product.image_url, ''), LEFT(BTRIM(COALESCE(p_note, '')), 500), now(), now()
  ) RETURNING * INTO v_change;
  RETURN jsonb_build_object('factory', to_jsonb(v_record), 'product', to_jsonb(v_product), 'change', to_jsonb(v_change));
END;
$$;

-- doing → done 原子转仓，并为销售库存生成标准入库流水。
CREATE OR REPLACE FUNCTION transfer_factory_inventory(
  p_product_id BIGINT, p_variant_ids TEXT[], p_quantities INTEGER[],
  p_operator TEXT DEFAULT '', p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid(); v_team_id UUID; v_role TEXT; v_user_name TEXT;
  v_product products%ROWTYPE; v_factory factory_inventory%ROWTYPE;
  v_product_variants JSONB; v_factory_variants JSONB; v_variant JSONB;
  v_movement stock_movements%ROWTYPE; v_change product_changes%ROWTYPE; v_movements JSONB := jsonb_build_array();
  v_index INTEGER; v_count INTEGER; v_quantity INTEGER; v_pending INTEGER; v_operation_id TEXT;
  v_old_summary TEXT; v_new_summary TEXT; v_transfer_summary TEXT;
BEGIN
  SELECT member.team_id, member.role, member.display_name INTO v_team_id, v_role, v_user_name FROM team_members member WHERE member.user_id = v_user_id LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无待出货入库权限'; END IF;
  v_count := COALESCE(cardinality(p_variant_ids), 0);
  IF v_count = 0 OR cardinality(p_quantities) IS DISTINCT FROM v_count THEN RAISE EXCEPTION '尺码与数量参数不完整'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity <= 0) THEN RAISE EXCEPTION '入库数量必须是大于0的整数'; END IF;
  IF (SELECT COUNT(DISTINCT input.value) FROM unnest(p_variant_ids) AS input(value)) <> v_count THEN RAISE EXCEPTION '尺码参数不能重复'; END IF;
  IF NULLIF(p_client_operation_id, '') IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id || '_1';
    IF v_movement.id IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id;
      SELECT * INTO v_factory FROM factory_inventory WHERE product_id = p_product_id AND team_id = v_team_id;
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'factory', to_jsonb(v_factory), 'movements', jsonb_build_array(), 'duplicate', true);
    END IF;
  END IF;
  SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id AND status = 'done' FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '销售商品不存在'; END IF;
  SELECT * INTO v_factory FROM factory_inventory WHERE product_id = p_product_id AND team_id = v_team_id FOR UPDATE;
  IF v_factory.id IS NULL THEN RAISE EXCEPTION '该商品没有待出货库存'; END IF;
  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_old_summary
  FROM jsonb_array_elements(COALESCE(v_factory.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;
  FOR v_index IN 1..v_count LOOP
    v_quantity := p_quantities[v_index];
    SELECT value INTO v_variant FROM jsonb_array_elements(v_factory.variants) WHERE value->>'id' = p_variant_ids[v_index] LIMIT 1;
    IF v_variant IS NULL THEN RAISE EXCEPTION '待出货商品尺码不存在'; END IF;
    v_pending := COALESCE((v_variant->>'quantity')::INTEGER, 0);
    IF v_pending < v_quantity THEN RAISE EXCEPTION '尺码 % 待出货数量不足，当前数量 %', v_variant->>'size', v_pending; END IF;
  END LOOP;
  SELECT jsonb_agg(CASE WHEN variant->>'id' = ANY(p_variant_ids) THEN jsonb_set(variant, '{current_stock}', to_jsonb(
    COALESCE((variant->>'current_stock')::INTEGER, 0) + COALESCE((SELECT p_quantities[position] FROM generate_subscripts(p_variant_ids, 1) position WHERE p_variant_ids[position] = variant->>'id' LIMIT 1), 0)
  )) ELSE variant END) INTO v_product_variants FROM jsonb_array_elements(v_product.variants) variant;
  SELECT jsonb_agg(CASE WHEN variant->>'id' = ANY(p_variant_ids) THEN jsonb_set(variant, '{quantity}', to_jsonb(
    COALESCE((variant->>'quantity')::INTEGER, 0) - COALESCE((SELECT p_quantities[position] FROM generate_subscripts(p_variant_ids, 1) position WHERE p_variant_ids[position] = variant->>'id' LIMIT 1), 0)
  )) ELSE variant END) INTO v_factory_variants FROM jsonb_array_elements(v_factory.variants) variant;
  UPDATE products SET variants = v_product_variants, updated_at = now() WHERE id = v_product.id RETURNING * INTO v_product;
  UPDATE factory_inventory SET variants = v_factory_variants, updated_at = now() WHERE id = v_factory.id RETURNING * INTO v_factory;
  FOR v_index IN 1..v_count LOOP
    v_quantity := p_quantities[v_index];
    SELECT value INTO v_variant FROM jsonb_array_elements(v_product.variants) WHERE value->>'id' = p_variant_ids[v_index] LIMIT 1;
    v_operation_id := CASE WHEN NULLIF(p_client_operation_id, '') IS NULL THEN NULL ELSE p_client_operation_id || '_' || v_index END;
    INSERT INTO stock_movements(team_id, product_id, user_id, type, quantity, reason, operator, client_operation_id, variant_id, variant_size, variant_barcode)
    VALUES (v_team_id, v_product.id, v_user_id, 'in', v_quantity, '大货入库', COALESCE(p_operator, ''), v_operation_id,
      p_variant_ids[v_index], COALESCE(v_variant->>'size', ''), COALESCE(v_variant->>'barcode', '')) RETURNING * INTO v_movement;
    v_movements := v_movements || jsonb_build_array(to_jsonb(v_movement));
  END LOOP;
  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_new_summary
  FROM jsonb_array_elements(COALESCE(v_factory.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;
  SELECT COALESCE(string_agg(
    format('%s +%s', COALESCE((
      SELECT variant->>'size' FROM jsonb_array_elements(v_product.variants) variant
      WHERE variant->>'id' = p_variant_ids[position] LIMIT 1
    ), p_variant_ids[position]), p_quantities[position]),
    '、' ORDER BY position
  ), '无') INTO v_transfer_summary
  FROM generate_subscripts(p_variant_ids, 1) position;
  INSERT INTO product_changes(
    team_id, product_id, user_id, user_name, action, field,
    old_value, new_value, product_name, product_image, created_at, synced_at
  ) VALUES (
    v_team_id, v_product.id, v_user_id, COALESCE(v_user_name, ''), 'update', '待出货转销售库存',
    format('待出货：%s', v_old_summary),
    format('待出货：%s；大货入库：%s', v_new_summary, v_transfer_summary),
    v_product.name, COALESCE(v_product.image_url, ''), now(), now()
  ) RETURNING * INTO v_change;
  RETURN jsonb_build_object(
    'product', to_jsonb(v_product), 'factory', to_jsonb(v_factory),
    'movements', v_movements, 'change', to_jsonb(v_change), 'duplicate', false
  );
END;
$$;

REVOKE ALL ON FUNCTION set_factory_inventory(BIGINT, TEXT[], INTEGER[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION add_factory_inventory(BIGINT, TEXT[], INTEGER[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION transfer_factory_inventory(BIGINT, TEXT[], INTEGER[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_factory_inventory(BIGINT, TEXT[], INTEGER[]) TO authenticated;
GRANT EXECUTE ON FUNCTION add_factory_inventory(BIGINT, TEXT[], INTEGER[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION transfer_factory_inventory(BIGINT, TEXT[], INTEGER[], TEXT, TEXT) TO authenticated;


+-- 面辅料库存管理：主档、商品关联、购买入库与工厂裁数消耗。

CREATE TABLE IF NOT EXISTS inventory_materials (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fabric', 'accessory')),
  name TEXT NOT NULL,
  contact_wechat TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  color_code TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL CHECK (unit IN ('米', '个', '件')),
  current_stock NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  min_stock NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  alert_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_materials_team ON inventory_materials(team_id);
CREATE INDEX IF NOT EXISTS idx_inventory_materials_kind ON inventory_materials(team_id, kind);

CREATE TABLE IF NOT EXISTS inventory_material_product_links (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES inventory_materials(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  part TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(material_id, product_id, part)
);
CREATE INDEX IF NOT EXISTS idx_material_links_team ON inventory_material_product_links(team_id);
CREATE INDEX IF NOT EXISTS idx_material_links_material ON inventory_material_product_links(material_id);
CREATE INDEX IF NOT EXISTS idx_material_links_product ON inventory_material_product_links(product_id);

CREATE TABLE IF NOT EXISTS material_purchases (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES inventory_materials(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  user_name TEXT NOT NULL DEFAULT '',
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT NOT NULL DEFAULT '',
  client_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_material_purchases_team ON material_purchases(team_id);
CREATE INDEX IF NOT EXISTS idx_material_purchases_material ON material_purchases(material_id);
CREATE INDEX IF NOT EXISTS idx_material_purchases_date ON material_purchases(purchase_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_material_purchases_operation
  ON material_purchases(team_id, client_operation_id) WHERE client_operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS material_consumptions (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES inventory_materials(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id),
  user_name TEXT NOT NULL DEFAULT '',
  cut_quantity INTEGER NOT NULL DEFAULT 0 CHECK (cut_quantity >= 0),
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  consumed_at DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT NOT NULL DEFAULT '',
  client_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_material_consumptions_team ON material_consumptions(team_id);
CREATE INDEX IF NOT EXISTS idx_material_consumptions_material ON material_consumptions(material_id);
CREATE INDEX IF NOT EXISTS idx_material_consumptions_date ON material_consumptions(consumed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_material_consumptions_operation
  ON material_consumptions(team_id, client_operation_id) WHERE client_operation_id IS NOT NULL;

ALTER TABLE inventory_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_material_product_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_consumptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inventory_materials_read" ON inventory_materials;
DROP POLICY IF EXISTS "inventory_materials_insert" ON inventory_materials;
DROP POLICY IF EXISTS "inventory_materials_update" ON inventory_materials;
DROP POLICY IF EXISTS "inventory_materials_delete" ON inventory_materials;
CREATE POLICY "inventory_materials_read" ON inventory_materials FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "inventory_materials_insert" ON inventory_materials FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "inventory_materials_update" ON inventory_materials FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "inventory_materials_delete" ON inventory_materials FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() = 'admin');

DROP POLICY IF EXISTS "material_links_read" ON inventory_material_product_links;
DROP POLICY IF EXISTS "material_links_write" ON inventory_material_product_links;
DROP POLICY IF EXISTS "material_links_update" ON inventory_material_product_links;
DROP POLICY IF EXISTS "material_links_delete" ON inventory_material_product_links;
CREATE POLICY "material_links_read" ON inventory_material_product_links FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "material_links_write" ON inventory_material_product_links FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "material_links_update" ON inventory_material_product_links FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "material_links_delete" ON inventory_material_product_links FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

DROP POLICY IF EXISTS "material_purchases_read" ON material_purchases;
DROP POLICY IF EXISTS "material_purchases_write" ON material_purchases;
CREATE POLICY "material_purchases_read" ON material_purchases FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "material_purchases_write" ON material_purchases FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

DROP POLICY IF EXISTS "material_consumptions_read" ON material_consumptions;
DROP POLICY IF EXISTS "material_consumptions_write" ON material_consumptions;
CREATE POLICY "material_consumptions_read" ON material_consumptions FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "material_consumptions_write" ON material_consumptions FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

DROP TRIGGER IF EXISTS set_inventory_materials_updated_at ON inventory_materials;
CREATE TRIGGER set_inventory_materials_updated_at BEFORE UPDATE ON inventory_materials
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE FUNCTION save_inventory_material(
  p_id BIGINT,
  p_kind TEXT,
  p_name TEXT,
  p_contact_wechat TEXT,
  p_model TEXT,
  p_color_code TEXT,
  p_unit TEXT,
  p_initial_stock NUMERIC,
  p_min_stock NUMERIC,
  p_alert_disabled BOOLEAN,
  p_note TEXT,
  p_links JSONB
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID; v_role TEXT; v_material inventory_materials%ROWTYPE; v_link JSONB;
BEGIN
  SELECT team_id, role INTO v_team_id, v_role FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无面辅料编辑权限'; END IF;
  IF BTRIM(COALESCE(p_name, '')) = '' THEN RAISE EXCEPTION '名称不能为空'; END IF;
  IF p_kind NOT IN ('fabric', 'accessory') THEN RAISE EXCEPTION '面辅料类型无效'; END IF;
  IF (p_kind = 'fabric' AND p_unit <> '米') OR (p_kind = 'accessory' AND p_unit NOT IN ('个', '件')) THEN RAISE EXCEPTION '单位与类型不匹配'; END IF;
  IF COALESCE(p_min_stock, 0) < 0 THEN RAISE EXCEPTION '最低库存不能为负数'; END IF;
  IF COALESCE(p_initial_stock, 0) < 0 THEN RAISE EXCEPTION '初始库存不能为负数'; END IF;
  IF p_kind = 'accessory' AND (
    COALESCE(p_min_stock, 0) <> TRUNC(COALESCE(p_min_stock, 0)) OR
    COALESCE(p_initial_stock, 0) <> TRUNC(COALESCE(p_initial_stock, 0))
  ) THEN RAISE EXCEPTION '辅料库存只能填写整数'; END IF;
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'array' THEN RAISE EXCEPTION '关联商品格式无效'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO inventory_materials(team_id, kind, name, contact_wechat, model, color_code, unit, current_stock, min_stock, alert_disabled, note, created_by, updated_by)
    VALUES (v_team_id, p_kind, BTRIM(p_name), BTRIM(COALESCE(p_contact_wechat, '')), BTRIM(COALESCE(p_model, '')),
      BTRIM(COALESCE(p_color_code, '')), p_unit, COALESCE(p_initial_stock, 0), COALESCE(p_min_stock, 0), COALESCE(p_alert_disabled, FALSE),
      LEFT(BTRIM(COALESCE(p_note, '')), 500), auth.uid(), auth.uid()) RETURNING * INTO v_material;
  ELSE
    UPDATE inventory_materials SET kind = p_kind, name = BTRIM(p_name), contact_wechat = BTRIM(COALESCE(p_contact_wechat, '')),
      model = BTRIM(COALESCE(p_model, '')), color_code = BTRIM(COALESCE(p_color_code, '')), unit = p_unit,
      min_stock = COALESCE(p_min_stock, 0), alert_disabled = COALESCE(p_alert_disabled, FALSE),
      note = LEFT(BTRIM(COALESCE(p_note, '')), 500), updated_by = auth.uid()
    WHERE id = p_id AND team_id = v_team_id RETURNING * INTO v_material;
    IF v_material.id IS NULL THEN RAISE EXCEPTION '面辅料不存在'; END IF;
  END IF;

  DELETE FROM inventory_material_product_links WHERE material_id = v_material.id AND team_id = v_team_id;
  FOR v_link IN SELECT value FROM jsonb_array_elements(p_links) LOOP
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = (v_link->>'product_id')::BIGINT AND team_id = v_team_id) THEN
      RAISE EXCEPTION '关联商品不存在';
    END IF;
    INSERT INTO inventory_material_product_links(team_id, material_id, product_id, part)
    VALUES (v_team_id, v_material.id, (v_link->>'product_id')::BIGINT, LEFT(BTRIM(COALESCE(v_link->>'part', '')), 100))
    ON CONFLICT (material_id, product_id, part) DO NOTHING;
  END LOOP;
  RETURN jsonb_build_object('material', to_jsonb(v_material), 'links', COALESCE((SELECT jsonb_agg(to_jsonb(link)) FROM inventory_material_product_links link WHERE link.material_id = v_material.id), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION record_material_purchase(
  p_material_id BIGINT, p_quantity NUMERIC, p_amount NUMERIC, p_purchase_date DATE,
  p_note TEXT DEFAULT '', p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID; v_role TEXT; v_user_name TEXT; v_material inventory_materials%ROWTYPE; v_record material_purchases%ROWTYPE;
BEGIN
  SELECT team_id, role, display_name INTO v_team_id, v_role, v_user_name FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无购买记录录入权限'; END IF;
  IF COALESCE(p_quantity, 0) <= 0 THEN RAISE EXCEPTION '购买数量必须大于0'; END IF;
  IF COALESCE(p_amount, 0) < 0 THEN RAISE EXCEPTION '花费不能为负数'; END IF;
  IF NULLIF(p_client_operation_id, '') IS NOT NULL THEN
    SELECT * INTO v_record FROM material_purchases WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_record.id IS NOT NULL THEN SELECT * INTO v_material FROM inventory_materials WHERE id = v_record.material_id; RETURN jsonb_build_object('material', to_jsonb(v_material), 'record', to_jsonb(v_record), 'duplicate', true); END IF;
  END IF;
  SELECT * INTO v_material FROM inventory_materials WHERE id = p_material_id AND team_id = v_team_id FOR UPDATE;
  IF v_material.id IS NULL THEN RAISE EXCEPTION '面辅料不存在'; END IF;
  IF v_material.kind = 'accessory' AND p_quantity <> TRUNC(p_quantity) THEN RAISE EXCEPTION '辅料购买数量只能填写整数'; END IF;
  UPDATE inventory_materials SET current_stock = current_stock + p_quantity, updated_by = auth.uid() WHERE id = v_material.id RETURNING * INTO v_material;
  INSERT INTO material_purchases(team_id, material_id, user_id, user_name, quantity, amount, purchase_date, note, client_operation_id)
  VALUES (v_team_id, v_material.id, auth.uid(), COALESCE(v_user_name, ''), p_quantity, COALESCE(p_amount, 0), COALESCE(p_purchase_date, CURRENT_DATE), LEFT(BTRIM(COALESCE(p_note, '')), 500), NULLIF(p_client_operation_id, '')) RETURNING * INTO v_record;
  RETURN jsonb_build_object('material', to_jsonb(v_material), 'record', to_jsonb(v_record), 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION record_material_consumption(
  p_material_id BIGINT, p_product_id BIGINT, p_cut_quantity INTEGER, p_quantity NUMERIC,
  p_consumed_at DATE, p_note TEXT DEFAULT '', p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID; v_role TEXT; v_user_name TEXT; v_material inventory_materials%ROWTYPE; v_record material_consumptions%ROWTYPE;
BEGIN
  SELECT team_id, role, display_name INTO v_team_id, v_role, v_user_name FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无裁数消耗录入权限'; END IF;
  IF COALESCE(p_quantity, 0) <= 0 THEN RAISE EXCEPTION '消耗数量必须大于0'; END IF;
  IF COALESCE(p_cut_quantity, 0) < 0 THEN RAISE EXCEPTION '工厂裁数不能为负数'; END IF;
  IF p_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products WHERE id = p_product_id AND team_id = v_team_id) THEN RAISE EXCEPTION '关联商品不存在'; END IF;
  IF NULLIF(p_client_operation_id, '') IS NOT NULL THEN
    SELECT * INTO v_record FROM material_consumptions WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_record.id IS NOT NULL THEN SELECT * INTO v_material FROM inventory_materials WHERE id = v_record.material_id; RETURN jsonb_build_object('material', to_jsonb(v_material), 'record', to_jsonb(v_record), 'duplicate', true); END IF;
  END IF;
  SELECT * INTO v_material FROM inventory_materials WHERE id = p_material_id AND team_id = v_team_id FOR UPDATE;
  IF v_material.id IS NULL THEN RAISE EXCEPTION '面辅料不存在'; END IF;
  IF v_material.kind = 'accessory' AND p_quantity <> TRUNC(p_quantity) THEN RAISE EXCEPTION '辅料消耗数量只能填写整数'; END IF;
  IF v_material.current_stock < p_quantity THEN RAISE EXCEPTION '库存不足，当前库存 % %', v_material.current_stock, v_material.unit; END IF;
  UPDATE inventory_materials SET current_stock = current_stock - p_quantity, updated_by = auth.uid() WHERE id = v_material.id RETURNING * INTO v_material;
  INSERT INTO material_consumptions(team_id, material_id, product_id, user_id, user_name, cut_quantity, quantity, consumed_at, note, client_operation_id)
  VALUES (v_team_id, v_material.id, p_product_id, auth.uid(), COALESCE(v_user_name, ''), COALESCE(p_cut_quantity, 0), p_quantity,
    COALESCE(p_consumed_at, CURRENT_DATE), LEFT(BTRIM(COALESCE(p_note, '')), 500), NULLIF(p_client_operation_id, '')) RETURNING * INTO v_record;
  RETURN jsonb_build_object('material', to_jsonb(v_material), 'record', to_jsonb(v_record), 'duplicate', false);
END;
$$;

REVOKE ALL ON FUNCTION save_inventory_material(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_material_purchase(BIGINT, NUMERIC, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_material_consumption(BIGINT, BIGINT, INTEGER, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_inventory_material(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION record_material_purchase(BIGINT, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION record_material_consumption(BIGINT, BIGINT, INTEGER, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

ALTER TABLE inventory_materials REPLICA IDENTITY FULL;
ALTER TABLE inventory_material_product_links REPLICA IDENTITY FULL;
ALTER TABLE material_purchases REPLICA IDENTITY FULL;
ALTER TABLE material_consumptions REPLICA IDENTITY FULL;
DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['inventory_materials', 'inventory_material_product_links', 'material_purchases', 'material_consumptions'] LOOP
    BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', v_table);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
EXCEPTION WHEN undefined_object THEN RAISE NOTICE 'supabase_realtime publication 不存在';
END $$;

-- 本文件全部 DDL 执行完成后刷新 API schema cache。
UPDATE products product
SET current_stock = COALESCE((
  SELECT SUM(COALESCE((variant->>'current_stock')::INTEGER, 0))
  FROM jsonb_array_elements(product.variants) variant
), 0);

NOTIFY pgrst, 'reload schema';
