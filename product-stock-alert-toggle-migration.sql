-- 商品级库存预警开关。
-- 在已有 Supabase 项目中执行一次；关闭提醒不会清除各尺码原有的预警值。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_alert_disabled BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
