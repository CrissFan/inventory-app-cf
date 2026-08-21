-- 商品尺码规格迁移：商品本身不再持有条形码，条形码和库存下沉到 variants。
-- 先执行本文件，再发布新版前端。旧商品会无损迁移为一个“默认规格”。

ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS variant_id TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS variant_size TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS variant_barcode TEXT DEFAULT '';

UPDATE products
SET variants = jsonb_build_array(jsonb_build_object(
  'id', 'legacy_' || id::TEXT,
  'size', '默认规格',
  'barcode', COALESCE(barcode, ''),
  'current_stock', GREATEST(0, COALESCE(current_stock, 0)),
  'min_stock', GREATEST(0, COALESCE(min_stock, 0))
))
WHERE variants = '[]'::JSONB;

UPDATE stock_movements AS movement
SET variant_id = 'legacy_' || movement.product_id::TEXT,
    variant_size = '默认规格',
    variant_barcode = COALESCE(product.barcode, '')
FROM products AS product
WHERE movement.product_id = product.id AND movement.variant_id IS NULL;

DO $$
DECLARE v_duplicate TEXT;
BEGIN
  SELECT item->>'barcode' INTO v_duplicate
  FROM products product, jsonb_array_elements(product.variants) item
  WHERE BTRIM(COALESCE(item->>'barcode', '')) <> ''
  GROUP BY product.team_id, item->>'barcode'
  HAVING COUNT(*) > 1
  LIMIT 1;
  IF v_duplicate IS NOT NULL THEN
    RAISE WARNING '发现现有重复条形码 %；迁移将继续，请迁移后在商品管理中修正', v_duplicate;
  END IF;
END $$;

-- 同一团队内所有非空规格条形码必须唯一，并自动维护商品汇总库存。
CREATE OR REPLACE FUNCTION validate_product_variants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_variant JSONB;
  v_barcode TEXT;
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
  FOR v_variant IN SELECT value FROM jsonb_array_elements(NEW.variants)
  LOOP
    IF BTRIM(COALESCE(v_variant->>'id', '')) = '' THEN RAISE EXCEPTION '规格缺少 ID'; END IF;
    IF BTRIM(COALESCE(v_variant->>'size', '')) = '' THEN RAISE EXCEPTION '尺码不能为空'; END IF;
    IF COALESCE((v_variant->>'current_stock')::INTEGER, 0) < 0 THEN RAISE EXCEPTION '规格库存不能为负数'; END IF;
    IF COALESCE((v_variant->>'min_stock')::INTEGER, 0) < 0 THEN RAISE EXCEPTION '尺码预警值不能为负数'; END IF;
    v_barcode := BTRIM(COALESCE(v_variant->>'barcode', ''));
    IF v_barcode <> '' THEN
      IF (SELECT COUNT(*) FROM jsonb_array_elements(NEW.variants) item
          WHERE BTRIM(COALESCE(item->>'barcode', '')) = v_barcode) > 1 THEN
        RAISE EXCEPTION '条形码 % 在当前商品中重复', v_barcode;
      END IF;
      IF EXISTS (
        SELECT 1 FROM products product, jsonb_array_elements(product.variants) item
        WHERE product.team_id = NEW.team_id
          AND product.id IS DISTINCT FROM NEW.id
          AND BTRIM(COALESCE(item->>'barcode', '')) = v_barcode
      ) THEN RAISE EXCEPTION '条形码 % 已被其他商品尺码占用', v_barcode; END IF;
    END IF;
  END LOOP;

  NEW.barcode := '';
  NEW.current_stock := COALESCE((
    SELECT SUM(COALESCE((item->>'current_stock')::INTEGER, 0))
    FROM jsonb_array_elements(NEW.variants) item
  ), 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_products_variants ON products;
CREATE TRIGGER validate_products_variants
  BEFORE INSERT OR UPDATE OF variants, barcode ON products
  FOR EACH ROW EXECUTE FUNCTION validate_product_variants();

CREATE OR REPLACE FUNCTION apply_variant_stock_movement(
  p_product_id BIGINT,
  p_variant_id TEXT,
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
  v_variant JSONB;
  v_variants JSONB;
  v_stock INTEGER;
BEGIN
  SELECT member.team_id, member.role INTO v_team_id, v_role
  FROM team_members member WHERE member.user_id = v_user LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无出入库权限'; END IF;
  IF p_type NOT IN ('in', 'out') THEN RAISE EXCEPTION '无效的出入库类型'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION '数量必须大于0'; END IF;
  IF BTRIM(COALESCE(p_variant_id, '')) = '' THEN RAISE EXCEPTION '请选择商品尺码'; END IF;

  IF p_client_operation_id IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements
    WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_movement.id IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = v_movement.product_id;
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', true);
    END IF;
  END IF;

  SELECT * INTO v_product FROM products
  WHERE id = p_product_id AND team_id = v_team_id FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '商品不存在'; END IF;

  SELECT value INTO v_variant FROM jsonb_array_elements(v_product.variants)
  WHERE value->>'id' = p_variant_id LIMIT 1;
  IF v_variant IS NULL THEN RAISE EXCEPTION '商品尺码不存在'; END IF;
  v_stock := COALESCE((v_variant->>'current_stock')::INTEGER, 0);
  IF p_type = 'out' AND v_stock < p_quantity THEN
    RAISE EXCEPTION '尺码 % 库存不足，当前库存 %', v_variant->>'size', v_stock;
  END IF;

  SELECT jsonb_agg(
    CASE WHEN item->>'id' = p_variant_id THEN
      jsonb_set(item, '{current_stock}', to_jsonb(v_stock + CASE WHEN p_type = 'in' THEN p_quantity ELSE -p_quantity END))
    ELSE item END
  ) INTO v_variants FROM jsonb_array_elements(v_product.variants) item;

  UPDATE products SET variants = v_variants WHERE id = v_product.id RETURNING * INTO v_product;
  INSERT INTO stock_movements(
    team_id, product_id, user_id, type, quantity, reason, operator, client_operation_id,
    variant_id, variant_size, variant_barcode
  ) VALUES (
    v_team_id, v_product.id, v_user, p_type, p_quantity, COALESCE(p_reason, ''),
    COALESCE(p_operator, ''), p_client_operation_id, p_variant_id,
    COALESCE(v_variant->>'size', ''), COALESCE(v_variant->>'barcode', '')
  ) RETURNING * INTO v_movement;

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

-- 旧客户端兼容：仅单规格商品允许继续调用旧 RPC；多规格商品要求升级客户端。
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
  v_variants JSONB;
  v_variant_id TEXT;
BEGIN
  SELECT variants INTO v_variants FROM products
  WHERE id = p_product_id AND team_id = get_my_team_id();
  IF v_variants IS NULL THEN RAISE EXCEPTION '商品不存在'; END IF;
  IF jsonb_array_length(v_variants) <> 1 THEN RAISE EXCEPTION '该商品包含多个尺码，请升级客户端后操作'; END IF;
  v_variant_id := v_variants->0->>'id';
  RETURN apply_variant_stock_movement(
    p_product_id, v_variant_id, p_type, p_quantity, p_reason, p_operator, p_client_operation_id
  );
END;
$$;

-- 按每个尺码的完整流水重新计算库存，再由触发器汇总商品总库存。
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

  UPDATE products product SET variants = (
    SELECT jsonb_agg(jsonb_set(
      variant, '{current_stock}', to_jsonb(GREATEST(0, COALESCE((
        SELECT SUM(CASE WHEN movement.type = 'in' THEN movement.quantity ELSE -movement.quantity END)
        FROM stock_movements movement
        WHERE movement.team_id = v_team_id
          AND movement.product_id = product.id
          AND movement.variant_id = variant->>'id'
      ), 0)))
    )) FROM jsonb_array_elements(product.variants) variant
  ) WHERE product.team_id = v_team_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 无论历史 current_stock 是否准确，都以各尺码库存之和修正商品汇总库存。
UPDATE products product
SET current_stock = COALESCE((
  SELECT SUM(COALESCE((variant->>'current_stock')::INTEGER, 0))
  FROM jsonb_array_elements(product.variants) variant
), 0);

-- 让 Supabase PostgREST 立即识别新增 RPC，避免等待 schema cache 自动刷新。
NOTIFY pgrst, 'reload schema';
