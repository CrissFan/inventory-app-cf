-- ===================================================================
-- 可选迁移：放宽商品删除权限（与 insert/update 保持一致）
-- 当前 products_delete 仅允许 admin，而 products_insert/update 允许
-- admin + member，策略不一致。若你的账号是「成员(member)」而非管理员，
-- 删除商品会被 RLS 拦截 → 云端不删除 → 其他端数量不变。
-- 在 Supabase SQL Editor 执行本脚本即可让成员也能删除商品。
-- （团队所有者/管理员无需执行）
-- ===================================================================

DROP POLICY IF EXISTS "products_delete" ON products;

CREATE POLICY "products_delete" ON products
  FOR DELETE USING (
    team_id = get_my_team_id()
    AND get_my_role() IN ('admin', 'member')
  );
