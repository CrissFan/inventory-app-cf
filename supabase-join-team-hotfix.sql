-- 修复 join_team_by_invite 返回字段 invite_code 与 teams.invite_code 同名歧义。
CREATE OR REPLACE FUNCTION join_team_by_invite(p_invite_code TEXT, p_display_name TEXT DEFAULT '')
RETURNS TABLE(team_id UUID, team_name TEXT, invite_code TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_team teams%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = v_user) THEN
    RAISE EXCEPTION '当前用户已经加入团队';
  END IF;

  SELECT t.* INTO v_team
  FROM teams AS t
  WHERE UPPER(t.invite_code) = UPPER(BTRIM(p_invite_code))
  LIMIT 1;
  IF v_team.id IS NULL THEN RAISE EXCEPTION '邀请码无效'; END IF;

  INSERT INTO team_members(team_id, user_id, display_name, role)
  VALUES (v_team.id, v_user, COALESCE(NULLIF(BTRIM(p_display_name), ''), '成员'), 'member');

  RETURN QUERY
  SELECT v_team.id, v_team.name, v_team.invite_code, 'member'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION join_team_by_invite(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_team_by_invite(TEXT, TEXT) TO authenticated;
