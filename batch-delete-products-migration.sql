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

NOTIFY pgrst, 'reload schema';
