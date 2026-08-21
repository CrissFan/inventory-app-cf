-- ===================================================================
-- 标签层级化迁移脚本
-- 在 Supabase SQL Editor 中执行。已存在 tags / products 表的库适用。
-- ===================================================================

-- 1. tags 表增加 parent_id（NULL = 一级标签）
ALTER TABLE tags ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES tags(id) ON DELETE CASCADE;

-- 移除旧的唯一约束（team_id, name），改用部分唯一索引，使一级标签名在团队内唯一、二级标签名在 (团队, 父级) 下唯一
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_team_id_name_key;

CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_top_unique ON tags(team_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_sub_unique ON tags(team_id, name, parent_id) WHERE parent_id IS NOT NULL;

-- 2. products 表增加 sub_tags（逗号分隔的二级标签名）
ALTER TABLE products ADD COLUMN IF NOT EXISTS sub_tags TEXT DEFAULT '';

-- 完成
