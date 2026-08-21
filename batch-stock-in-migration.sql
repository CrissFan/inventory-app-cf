-- 批量尺码出入库接口。依赖 product-variants-migration.sql 中的单条原子库存 RPC。

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

NOTIFY pgrst, 'reload schema';
