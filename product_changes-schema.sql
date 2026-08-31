-- 在 Supabase SQL Editor 中执行以下语句（只需执行一次）
-- 创建商品变更日志表 product_changes

CREATE TABLE IF NOT EXISTS product_changes (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  user_id UUID REFERENCES auth.users(id),
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
ALTER TABLE product_changes ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';

-- RLS 策略：仅团队成员可读写
ALTER TABLE product_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "changes_read" ON product_changes
  FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "changes_insert" ON product_changes
  FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
