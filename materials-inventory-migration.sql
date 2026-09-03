-- 面辅料库存管理：主档、商品关联、购买入库与工厂裁数消耗。

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

-- 立即让 PostgREST 识别新增 RPC，避免前端命中旧 schema cache。
NOTIFY pgrst, 'reload schema';
