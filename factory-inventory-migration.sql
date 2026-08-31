-- 工厂待出货库存（doing）与销售库存（done）。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';

-- 兼容早期版本的商品变更表，确保工厂库存操作可以写入完整日志。
ALTER TABLE product_changes
  ADD COLUMN IF NOT EXISTS user_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'update' CHECK (action IN ('create', 'update', 'delete')),
  ADD COLUMN IF NOT EXISTS product_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_image TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_status_check' AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('doing', 'done'));
  END IF;
END $$;

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

ALTER TABLE factory_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "factory_inventory_read" ON factory_inventory;
DROP POLICY IF EXISTS "factory_inventory_insert" ON factory_inventory;
DROP POLICY IF EXISTS "factory_inventory_update" ON factory_inventory;
DROP POLICY IF EXISTS "factory_inventory_delete" ON factory_inventory;
CREATE POLICY "factory_inventory_read" ON factory_inventory
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "factory_inventory_insert" ON factory_inventory
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "factory_inventory_update" ON factory_inventory
  FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "factory_inventory_delete" ON factory_inventory
  FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));

CREATE OR REPLACE FUNCTION set_factory_inventory(
  p_product_id BIGINT,
  p_variant_ids TEXT[],
  p_quantities INTEGER[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id UUID;
  v_role TEXT;
  v_user_name TEXT;
  v_product products%ROWTYPE;
  v_existing factory_inventory%ROWTYPE;
  v_variants JSONB;
  v_record factory_inventory%ROWTYPE;
  v_change product_changes%ROWTYPE;
  v_count INTEGER;
  v_old_summary TEXT;
  v_new_summary TEXT;
BEGIN
  SELECT member.team_id, member.role, member.display_name INTO v_team_id, v_role, v_user_name
  FROM team_members member WHERE member.user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无待出货库存编辑权限'; END IF;

  v_count := COALESCE(cardinality(p_variant_ids), 0);
  IF v_count = 0 OR cardinality(p_quantities) IS DISTINCT FROM v_count THEN RAISE EXCEPTION '尺码与数量参数不完整'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity < 0) THEN RAISE EXCEPTION '待出货数量不能为负数'; END IF;
  IF (SELECT COUNT(DISTINCT input.value) FROM unnest(p_variant_ids) AS input(value)) <> v_count THEN RAISE EXCEPTION '尺码参数不能重复'; END IF;

  SELECT * INTO v_product FROM products
  WHERE id = p_product_id AND team_id = v_team_id AND status = 'done' FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '销售商品不存在'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_variant_ids) AS input(id)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_product.variants) variant WHERE variant->>'id' = input.id)
  ) THEN RAISE EXCEPTION '待出货数据包含无效尺码'; END IF;

  SELECT * INTO v_existing FROM factory_inventory
  WHERE team_id = v_team_id AND product_id = v_product.id FOR UPDATE;

  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_old_summary
  FROM jsonb_array_elements(COALESCE(v_existing.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;

  SELECT jsonb_agg(jsonb_build_object(
    'id', variant->>'id',
    'size', COALESCE(variant->>'size', ''),
    'barcode', COALESCE(variant->>'barcode', ''),
    'quantity', COALESCE((
      SELECT p_quantities[position]
      FROM generate_subscripts(p_variant_ids, 1) position
      WHERE p_variant_ids[position] = variant->>'id'
      LIMIT 1
    ), 0)
  )) INTO v_variants
  FROM jsonb_array_elements(v_product.variants) variant;

  INSERT INTO factory_inventory(team_id, product_id, status, variants)
  VALUES (v_team_id, v_product.id, 'doing', COALESCE(v_variants, '[]'::JSONB))
  ON CONFLICT (team_id, product_id) DO UPDATE
    SET variants = EXCLUDED.variants, updated_at = now()
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

  RETURN jsonb_build_object(
    'factory', to_jsonb(v_record), 'product', to_jsonb(v_product), 'change', to_jsonb(v_change)
  );
END;
$$;

-- 重复录入采用增量合并，不覆盖已有 doing 数量。
DROP FUNCTION IF EXISTS add_factory_inventory(BIGINT, TEXT[], INTEGER[]);
CREATE OR REPLACE FUNCTION add_factory_inventory(
  p_product_id BIGINT,
  p_variant_ids TEXT[],
  p_quantities INTEGER[],
  p_note TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id UUID;
  v_role TEXT;
  v_user_name TEXT;
  v_product products%ROWTYPE;
  v_existing factory_inventory%ROWTYPE;
  v_variants JSONB;
  v_record factory_inventory%ROWTYPE;
  v_change product_changes%ROWTYPE;
  v_count INTEGER;
  v_old_summary TEXT;
  v_new_summary TEXT;
  v_added_summary TEXT;
BEGIN
  SELECT member.team_id, member.role, member.display_name INTO v_team_id, v_role, v_user_name
  FROM team_members member WHERE member.user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无待出货库存录入权限'; END IF;
  v_count := COALESCE(cardinality(p_variant_ids), 0);
  IF v_count = 0 OR cardinality(p_quantities) IS DISTINCT FROM v_count THEN RAISE EXCEPTION '尺码与数量参数不完整'; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity > 0) THEN RAISE EXCEPTION '请至少填写一个尺码的本次新增数量'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity < 0) THEN RAISE EXCEPTION '本次新增数量不能为负数'; END IF;
  IF (SELECT COUNT(DISTINCT input.value) FROM unnest(p_variant_ids) AS input(value)) <> v_count THEN RAISE EXCEPTION '尺码参数不能重复'; END IF;

  SELECT * INTO v_product FROM products
  WHERE id = p_product_id AND team_id = v_team_id AND status = 'done' FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '销售商品不存在'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_variant_ids) AS input(id)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_product.variants) variant WHERE variant->>'id' = input.id)
  ) THEN RAISE EXCEPTION '待出货数据包含无效尺码'; END IF;
  SELECT * INTO v_existing FROM factory_inventory
  WHERE team_id = v_team_id AND product_id = v_product.id FOR UPDATE;

  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_old_summary
  FROM jsonb_array_elements(COALESCE(v_existing.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;

  SELECT jsonb_agg(jsonb_build_object(
    'id', variant->>'id',
    'size', COALESCE(variant->>'size', ''),
    'barcode', COALESCE(variant->>'barcode', ''),
    'quantity',
      COALESCE((
        SELECT (existing_variant->>'quantity')::INTEGER
        FROM jsonb_array_elements(COALESCE(v_existing.variants, '[]'::JSONB)) existing_variant
        WHERE existing_variant->>'id' = variant->>'id' LIMIT 1
      ), 0)
      + COALESCE((
        SELECT p_quantities[position]
        FROM generate_subscripts(p_variant_ids, 1) position
        WHERE p_variant_ids[position] = variant->>'id' LIMIT 1
      ), 0)
  )) INTO v_variants
  FROM jsonb_array_elements(v_product.variants) variant;

  INSERT INTO factory_inventory(team_id, product_id, status, variants)
  VALUES (v_team_id, v_product.id, 'doing', COALESCE(v_variants, '[]'::JSONB))
  ON CONFLICT (team_id, product_id) DO UPDATE
    SET variants = EXCLUDED.variants, updated_at = now()
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

  RETURN jsonb_build_object(
    'factory', to_jsonb(v_record), 'product', to_jsonb(v_product), 'change', to_jsonb(v_change)
  );
END;
$$;

CREATE OR REPLACE FUNCTION transfer_factory_inventory(
  p_product_id BIGINT,
  p_variant_ids TEXT[],
  p_quantities INTEGER[],
  p_operator TEXT DEFAULT '',
  p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_team_id UUID;
  v_role TEXT;
  v_user_name TEXT;
  v_product products%ROWTYPE;
  v_factory factory_inventory%ROWTYPE;
  v_product_variants JSONB;
  v_factory_variants JSONB;
  v_variant JSONB;
  v_movement stock_movements%ROWTYPE;
  v_change product_changes%ROWTYPE;
  v_movements JSONB := jsonb_build_array();
  v_index INTEGER;
  v_count INTEGER;
  v_quantity INTEGER;
  v_pending INTEGER;
  v_operation_id TEXT;
  v_old_summary TEXT;
  v_new_summary TEXT;
  v_transfer_summary TEXT;
BEGIN
  SELECT member.team_id, member.role, member.display_name INTO v_team_id, v_role, v_user_name
  FROM team_members member WHERE member.user_id = v_user_id LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无待出货入库权限'; END IF;

  v_count := COALESCE(cardinality(p_variant_ids), 0);
  IF v_count = 0 OR cardinality(p_quantities) IS DISTINCT FROM v_count THEN RAISE EXCEPTION '尺码与数量参数不完整'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_quantities) AS input(quantity) WHERE input.quantity <= 0) THEN RAISE EXCEPTION '入库数量必须是大于0的整数'; END IF;
  IF (SELECT COUNT(DISTINCT input.value) FROM unnest(p_variant_ids) AS input(value)) <> v_count THEN RAISE EXCEPTION '尺码参数不能重复'; END IF;

  IF NULLIF(p_client_operation_id, '') IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements
    WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id || '_1';
    IF v_movement.id IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id;
      SELECT * INTO v_factory FROM factory_inventory WHERE product_id = p_product_id AND team_id = v_team_id;
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'factory', to_jsonb(v_factory), 'movements', jsonb_build_array(), 'duplicate', true);
    END IF;
  END IF;

  SELECT * INTO v_product FROM products
  WHERE id = p_product_id AND team_id = v_team_id AND status = 'done' FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '销售商品不存在'; END IF;
  SELECT * INTO v_factory FROM factory_inventory
  WHERE product_id = p_product_id AND team_id = v_team_id FOR UPDATE;
  IF v_factory.id IS NULL THEN RAISE EXCEPTION '该商品没有待出货库存'; END IF;

  SELECT COALESCE(string_agg(
    format('%s %s', COALESCE(item.value->>'size', '未命名尺码'), COALESCE((item.value->>'quantity')::INTEGER, 0)),
    '、' ORDER BY item.position
  ), '无库存') INTO v_old_summary
  FROM jsonb_array_elements(COALESCE(v_factory.variants, '[]'::JSONB)) WITH ORDINALITY AS item(value, position)
  WHERE COALESCE((item.value->>'quantity')::INTEGER, 0) > 0;

  FOR v_index IN 1..v_count LOOP
    v_quantity := p_quantities[v_index];
    SELECT value INTO v_variant FROM jsonb_array_elements(v_factory.variants)
    WHERE value->>'id' = p_variant_ids[v_index] LIMIT 1;
    IF v_variant IS NULL THEN RAISE EXCEPTION '待出货商品尺码不存在'; END IF;
    v_pending := COALESCE((v_variant->>'quantity')::INTEGER, 0);
    IF v_pending < v_quantity THEN
      RAISE EXCEPTION '尺码 % 待出货数量不足，当前数量 %', v_variant->>'size', v_pending;
    END IF;
  END LOOP;

  SELECT jsonb_agg(
    CASE WHEN variant->>'id' = ANY(p_variant_ids) THEN
      jsonb_set(variant, '{current_stock}', to_jsonb(
        COALESCE((variant->>'current_stock')::INTEGER, 0) +
        COALESCE((SELECT p_quantities[position] FROM generate_subscripts(p_variant_ids, 1) position WHERE p_variant_ids[position] = variant->>'id' LIMIT 1), 0)
      ))
    ELSE variant END
  ) INTO v_product_variants FROM jsonb_array_elements(v_product.variants) variant;

  SELECT jsonb_agg(
    CASE WHEN variant->>'id' = ANY(p_variant_ids) THEN
      jsonb_set(variant, '{quantity}', to_jsonb(
        COALESCE((variant->>'quantity')::INTEGER, 0) -
        COALESCE((SELECT p_quantities[position] FROM generate_subscripts(p_variant_ids, 1) position WHERE p_variant_ids[position] = variant->>'id' LIMIT 1), 0)
      ))
    ELSE variant END
  ) INTO v_factory_variants FROM jsonb_array_elements(v_factory.variants) variant;

  UPDATE products SET variants = v_product_variants, updated_at = now()
  WHERE id = v_product.id RETURNING * INTO v_product;
  UPDATE factory_inventory SET variants = v_factory_variants, updated_at = now()
  WHERE id = v_factory.id RETURNING * INTO v_factory;

  FOR v_index IN 1..v_count LOOP
    v_quantity := p_quantities[v_index];
    SELECT value INTO v_variant FROM jsonb_array_elements(v_product.variants)
    WHERE value->>'id' = p_variant_ids[v_index] LIMIT 1;
    v_operation_id := CASE WHEN NULLIF(p_client_operation_id, '') IS NULL THEN NULL ELSE p_client_operation_id || '_' || v_index END;
    INSERT INTO stock_movements(
      team_id, product_id, user_id, type, quantity, reason, operator, client_operation_id,
      variant_id, variant_size, variant_barcode
    ) VALUES (
      v_team_id, v_product.id, v_user_id, 'in', v_quantity, '大货入库',
      COALESCE(p_operator, ''), v_operation_id, p_variant_ids[v_index],
      COALESCE(v_variant->>'size', ''), COALESCE(v_variant->>'barcode', '')
    ) RETURNING * INTO v_movement;
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

ALTER TABLE factory_inventory REPLICA IDENTITY FULL;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE factory_inventory;
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_object THEN RAISE NOTICE 'supabase_realtime publication 不存在';
END $$;

NOTIFY pgrst, 'reload schema';
