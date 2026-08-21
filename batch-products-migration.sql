-- 批量创建商品：一次 RPC、一个事务完成标签补建、商品与变更记录插入。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_alert_disabled BOOLEAN NOT NULL DEFAULT FALSE;

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

NOTIFY pgrst, 'reload schema';
