-- 新品计划面板：基础资料、负责人和五阶段时间线。

CREATE TABLE IF NOT EXISTS new_product_plans (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product_type TEXT NOT NULL DEFAULT '',
  materials JSONB NOT NULL DEFAULT '[]'::JSONB,
  design_image_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  planned_launch_date DATE,
  stage TEXT NOT NULL DEFAULT 'pattern' CHECK (stage IN ('pattern', 'sample', 'adjust', 'preview', 'listed')),
  stage_timestamps JSONB NOT NULL DEFAULT '{}'::JSONB,
  assignee_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assignee_name TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_new_product_plans_team ON new_product_plans(team_id);
CREATE INDEX IF NOT EXISTS idx_new_product_plans_stage ON new_product_plans(team_id, stage);
CREATE INDEX IF NOT EXISTS idx_new_product_plans_launch ON new_product_plans(team_id, planned_launch_date);

ALTER TABLE new_product_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "new_product_plans_read" ON new_product_plans;
DROP POLICY IF EXISTS "new_product_plans_insert" ON new_product_plans;
DROP POLICY IF EXISTS "new_product_plans_update" ON new_product_plans;
DROP POLICY IF EXISTS "new_product_plans_delete" ON new_product_plans;
CREATE POLICY "new_product_plans_read" ON new_product_plans FOR SELECT USING (team_id = get_my_team_id());
CREATE POLICY "new_product_plans_insert" ON new_product_plans FOR INSERT WITH CHECK (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "new_product_plans_update" ON new_product_plans FOR UPDATE USING (team_id = get_my_team_id() AND get_my_role() IN ('admin', 'member'));
CREATE POLICY "new_product_plans_delete" ON new_product_plans FOR DELETE USING (team_id = get_my_team_id() AND get_my_role() = 'admin');

DROP TRIGGER IF EXISTS set_new_product_plans_updated_at ON new_product_plans;
CREATE TRIGGER set_new_product_plans_updated_at BEFORE UPDATE ON new_product_plans
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE FUNCTION save_new_product_plan(
  p_id BIGINT,
  p_name TEXT,
  p_product_type TEXT,
  p_material_ids BIGINT[],
  p_design_image_url TEXT,
  p_description TEXT,
  p_planned_launch_date DATE,
  p_assignee_user_id UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID;
  v_role TEXT;
  v_assignee_name TEXT := '';
  v_materials JSONB := '[]'::JSONB;
  v_record new_product_plans%ROWTYPE;
BEGIN
  SELECT team_id, role INTO v_team_id, v_role FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无新品计划编辑权限'; END IF;
  IF BTRIM(COALESCE(p_name, '')) = '' THEN RAISE EXCEPTION '商品名称不能为空'; END IF;
  IF p_assignee_user_id IS NOT NULL THEN
    SELECT display_name INTO v_assignee_name FROM team_members WHERE team_id = v_team_id AND user_id = p_assignee_user_id AND role IN ('admin', 'member');
    IF NOT FOUND THEN RAISE EXCEPTION '负责人必须是当前团队的管理员或成员'; END IF;
  END IF;
  IF COALESCE(cardinality(p_material_ids), 0) > 0 THEN
    IF (SELECT COUNT(DISTINCT id) FROM unnest(p_material_ids) input(id)) <> cardinality(p_material_ids) THEN RAISE EXCEPTION '面料不能重复选择'; END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_material_ids) input(id) WHERE NOT EXISTS (
      SELECT 1 FROM inventory_materials material WHERE material.id = input.id AND material.team_id = v_team_id AND material.kind = 'fabric'
    )) THEN RAISE EXCEPTION '选择的面料不存在'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', material.id, 'name', material.name, 'model', material.model,
      'color_code', material.color_code, 'unit', material.unit
    ) ORDER BY material.name), '[]'::JSONB) INTO v_materials
    FROM inventory_materials material WHERE material.team_id = v_team_id AND material.id = ANY(p_material_ids);
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO new_product_plans(
      team_id, name, product_type, materials, design_image_url, description, planned_launch_date,
      stage, stage_timestamps, assignee_user_id, assignee_name, created_by, updated_by
    ) VALUES (
      v_team_id, BTRIM(p_name), BTRIM(COALESCE(p_product_type, '')), v_materials,
      COALESCE(p_design_image_url, ''), LEFT(BTRIM(COALESCE(p_description, '')), 2000), p_planned_launch_date,
      'pattern', jsonb_build_object('pattern', now()), p_assignee_user_id, COALESCE(v_assignee_name, ''), auth.uid(), auth.uid()
    ) RETURNING * INTO v_record;
  ELSE
    UPDATE new_product_plans SET
      name = BTRIM(p_name), product_type = BTRIM(COALESCE(p_product_type, '')), materials = v_materials,
      design_image_url = COALESCE(p_design_image_url, ''), description = LEFT(BTRIM(COALESCE(p_description, '')), 2000),
      planned_launch_date = p_planned_launch_date, assignee_user_id = p_assignee_user_id,
      assignee_name = COALESCE(v_assignee_name, ''), updated_by = auth.uid()
    WHERE id = p_id AND team_id = v_team_id RETURNING * INTO v_record;
    IF v_record.id IS NULL THEN RAISE EXCEPTION '新品计划不存在'; END IF;
  END IF;
  RETURN to_jsonb(v_record);
END;
$$;

CREATE OR REPLACE FUNCTION advance_new_product_plan(p_id BIGINT, p_next_stage TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_id UUID;
  v_role TEXT;
  v_record new_product_plans%ROWTYPE;
  v_stages TEXT[] := ARRAY['pattern', 'sample', 'adjust', 'preview', 'listed'];
  v_current_index INTEGER;
BEGIN
  SELECT team_id, role INTO v_team_id, v_role FROM team_members WHERE user_id = auth.uid() LIMIT 1;
  IF v_team_id IS NULL OR v_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION '无新品进度管理权限'; END IF;
  SELECT * INTO v_record FROM new_product_plans WHERE id = p_id AND team_id = v_team_id FOR UPDATE;
  IF v_record.id IS NULL THEN RAISE EXCEPTION '新品计划不存在'; END IF;
  v_current_index := array_position(v_stages, v_record.stage);
  IF v_current_index >= array_length(v_stages, 1) THEN RAISE EXCEPTION '该商品已上架销售'; END IF;
  IF p_next_stage IS DISTINCT FROM v_stages[v_current_index + 1] THEN RAISE EXCEPTION '新品阶段必须按顺序推进'; END IF;
  UPDATE new_product_plans SET
    stage = p_next_stage,
    stage_timestamps = jsonb_set(COALESCE(stage_timestamps, '{}'::JSONB), ARRAY[p_next_stage], to_jsonb(now()), true),
    updated_by = auth.uid()
  WHERE id = v_record.id RETURNING * INTO v_record;
  RETURN to_jsonb(v_record);
END;
$$;

REVOKE ALL ON FUNCTION save_new_product_plan(BIGINT, TEXT, TEXT, BIGINT[], TEXT, TEXT, DATE, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_new_product_plan(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_new_product_plan(BIGINT, TEXT, TEXT, BIGINT[], TEXT, TEXT, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION advance_new_product_plan(BIGINT, TEXT) TO authenticated;

ALTER TABLE new_product_plans REPLICA IDENTITY FULL;
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE new_product_plans;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
EXCEPTION WHEN undefined_object THEN RAISE NOTICE 'supabase_realtime publication 不存在';
END $$;

NOTIFY pgrst, 'reload schema';
