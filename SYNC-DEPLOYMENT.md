# 多端同步修复部署

必须按以下顺序发布，避免新版前端调用尚不存在的数据库函数。

1. 在 Supabase 控制台创建数据库备份。
2. 在 SQL Editor 完整执行 `supabase-sync-fix.sql`。
3. 确认 Database → Replication 中 `products`、`tags`、`stock_movements`、`product_changes` 已启用 Realtime。
4. 在前端构建环境配置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，重新构建并部署。
5. 先后在电脑和手机打开新版并登录同一账号；等待“正在合并本机历史数据”消失且待同步数量归零。上传成功前不要清除浏览器数据。
6. 在任一端做一次测试入库，确认另一端数秒内同时出现库存变化和流水。

首次升级会在 IndexedDB 的 `meta` store 中保存 `migration_backup_v1` 快照。只有历史数据上传成功后，客户端才会记录迁移完成标记并用云端数据覆盖业务缓存。

如果界面显示同步异常，请保留两端浏览器数据，先根据错误信息修复数据库迁移或权限，不要反复创建相同商品或出入库。
