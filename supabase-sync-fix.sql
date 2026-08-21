-- 多端同步修复迁移
-- 先在 Supabase SQL Editor 执行本文件，再部署新版前端。

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS client_operation_id TEXT;
ALTER TABLE product_changes ADD COLUMN IF NOT EXISTS user_name TEXT DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_operation_unique
  ON stock_movements(team_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION get_current_membership()
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, member_id BIGINT, display_name TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.team_id, t.name, t.invite_code, tm.id, tm.display_name, tm.role
  FROM team_members tm JOIN teams t ON t.id = tm.team_id
  WHERE tm.user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION create_team_for_current_user(p_name TEXT, p_display_name TEXT DEFAULT '')
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_user UUID := auth.uid(); v_team teams%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = v_user) THEN RAISE EXCEPTION '当前用户已经加入团队'; END IF;
  INSERT INTO teams(name, invite_code)
  VALUES (COALESCE(NULLIF(BTRIM(p_name), ''), '我的团队'), 'INV_' || UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 8)))
  RETURNING * INTO v_team;
  INSERT INTO team_members(team_id, user_id, display_name, role)
  VALUES (v_team.id, v_user, COALESCE(NULLIF(BTRIM(p_display_name), ''), '管理员'), 'admin');
  RETURN QUERY SELECT v_team.id, v_team.name, v_team.invite_code, 'admin'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION join_team_by_invite(p_invite_code TEXT, p_display_name TEXT DEFAULT '')
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_user UUID := auth.uid(); v_team teams%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = v_user) THEN RAISE EXCEPTION '当前用户已经加入团队'; END IF;
  SELECT t.* INTO v_team FROM teams AS t WHERE UPPER(t.invite_code) = UPPER(BTRIM(p_invite_code)) LIMIT 1;
  IF v_team.id IS NULL THEN RAISE EXCEPTION '邀请码无效'; END IF;
  INSERT INTO team_members(team_id, user_id, display_name, role)
  VALUES (v_team.id, v_user, COALESCE(NULLIF(BTRIM(p_display_name), ''), '成员'), 'member');
  RETURN QUERY SELECT v_team.id, v_team.name, v_team.invite_code, 'member'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION apply_stock_movement(
  p_product_id BIGINT, p_type TEXT, p_quantity INTEGER, p_reason TEXT DEFAULT '',
  p_operator TEXT DEFAULT '', p_client_operation_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid(); v_team_id UUID; v_role TEXT;
  v_product products%ROWTYPE; v_movement stock_movements%ROWTYPE;
BEGIN
  SELECT tm.team_id, tm.role INTO v_team_id, v_role FROM team_members tm WHERE tm.user_id = v_user LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无出入库权限'; END IF;
  IF p_type NOT IN ('in', 'out') THEN RAISE EXCEPTION '无效的出入库类型'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION '数量必须大于0'; END IF;
  IF p_client_operation_id IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_movement.id IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = v_movement.product_id;
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', true);
    END IF;
  END IF;
  SELECT * INTO v_product FROM products WHERE id = p_product_id AND team_id = v_team_id FOR UPDATE;
  IF v_product.id IS NULL THEN RAISE EXCEPTION '商品不存在'; END IF;
  IF p_client_operation_id IS NOT NULL THEN
    SELECT * INTO v_movement FROM stock_movements WHERE team_id = v_team_id AND client_operation_id = p_client_operation_id;
    IF v_movement.id IS NOT NULL THEN
      RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', true);
    END IF;
  END IF;
  IF p_type = 'out' AND v_product.current_stock < p_quantity THEN RAISE EXCEPTION '库存不足，当前库存 %', v_product.current_stock; END IF;
  UPDATE products SET current_stock = current_stock + CASE WHEN p_type = 'in' THEN p_quantity ELSE -p_quantity END
    WHERE id = v_product.id RETURNING * INTO v_product;
  INSERT INTO stock_movements(team_id, product_id, user_id, type, quantity, reason, operator, client_operation_id)
    VALUES (v_team_id, v_product.id, v_user, p_type, p_quantity, COALESCE(p_reason, ''), COALESCE(p_operator, ''), p_client_operation_id)
    RETURNING * INTO v_movement;
  RETURN jsonb_build_object('product', to_jsonb(v_product), 'movement', to_jsonb(v_movement), 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION recalculate_team_inventory()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_team_id UUID; v_role TEXT; v_count INTEGER;
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

DO $$
DECLARE v_table TEXT;
BEGIN
  ALTER TABLE products REPLICA IDENTITY FULL;
  ALTER TABLE tags REPLICA IDENTITY FULL;
  ALTER TABLE stock_movements REPLICA IDENTITY FULL;
  ALTER TABLE product_changes REPLICA IDENTITY FULL;
  FOREACH v_table IN ARRAY ARRAY['products', 'tags', 'stock_movements', 'product_changes'] LOOP
    BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', v_table);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'supabase_realtime publication 不存在，请在 Supabase 控制台启用 Realtime';
END $$;
