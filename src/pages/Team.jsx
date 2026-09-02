import { useState, useEffect } from 'react';
import {
  Users, UserPlus, Copy, RefreshCw, Shield, ShieldCheck, Eye,
  Trash2, Edit, Check, X, Crown
} from 'lucide-react';
import {
  getTeam, addMember, updateMember, removeMember,
  updateTeamName, regenerateInviteCode,
} from '../api/client';
import { useAuth } from '../AuthContext';

const ROLE_CONFIG = {
  admin: { label: '管理员', icon: ShieldCheck, color: 'text-purple-600 bg-purple-50' },
  member: { label: '成员', icon: Shield, color: 'text-blue-600 bg-blue-50' },
  viewer: { label: '查看者', icon: Eye, color: 'text-gray-600 bg-gray-100' },
};

export default function Team() {
  const { user } = useAuth();
  const [team, setTeam] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [myRole, setMyRole] = useState('');

  // Add member form
  const [showAdd, setShowAdd] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState('member');
  const [addingMember, setAddingMember] = useState(false);

  // Edit member
  const [editId, setEditId] = useState(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editPwd, setEditPwd] = useState('');

  // Edit team name
  const [editingTeamName, setEditingTeamName] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');

  // Invite code
  const [copyMsg, setCopyMsg] = useState('');

  const isAdmin = myRole === 'admin';

  const loadTeam = async () => {
    try {
      const data = await getTeam();
      setTeam(data.team);
      setMembers(data.members);
      setMyRole(data.myRole || '');
    } catch (err) {
      setError('加载团队信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTeam(); }, []);

  const handleAddMember = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setAddingMember(true);
    try {
      const result = await addMember({ username: newUsername, password: newPassword, display_name: newDisplayName, role: newRole });
      if (result.member) setMembers(current => [...current, result.member]);
      setNewUsername(''); setNewPassword(''); setNewDisplayName(''); setNewRole('member');
      setShowAdd(false);
      setSuccess('成员添加成功');
    } catch (err) {
      setError(err.message || '添加失败');
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemove = async (id) => {
    if (!confirm('确定要移除该成员吗？')) return;
    setError('');
    try {
      await removeMember(id);
      setMembers(current => current.filter(member => member.id !== id));
      setSuccess('成员已移除');
    } catch (err) {
      setError(err.message || '移除失败');
    }
  };

  const handleSaveEdit = async (member) => {
    setError('');
    try {
      const updates = {};
      if (editDisplayName !== member.display_name) updates.display_name = editDisplayName;
      if (editRole !== member.role) updates.role = editRole;
      if (editPwd) updates.password = editPwd;
      if (Object.keys(updates).length === 0) {
        setEditId(null);
        return;
      }
      const result = await updateMember(member.id, updates);
      if (result.member) setMembers(current => current.map(item => item.id === member.id ? result.member : item));
      setEditId(null);
      setEditPwd('');
      setSuccess('成员信息已更新');
    } catch (err) {
      setError(err.message || '更新失败');
    }
  };

  const handleUpdateTeam = async () => {
    if (!newTeamName.trim()) return;
    setError('');
    try {
      await updateTeamName(newTeamName);
      setTeam(current => ({ ...current, name: newTeamName }));
      setEditingTeamName(false);
      setSuccess('团队名称已更新');
    } catch (err) {
      setError(err.message || '更新失败');
    }
  };

  const handleReInvite = async () => {
    setError('');
    try {
      const data = await regenerateInviteCode();
      setTeam({ ...team, invite_code: data.invite_code });
      setSuccess('邀请码已刷新');
    } catch (err) {
      setError(err.message || '刷新失败');
    }
  };

  const copyInvite = () => {
    navigator.clipboard.writeText(team?.invite_code || '').then(() => {
      setCopyMsg('已复制');
      setTimeout(() => setCopyMsg(''), 2000);
    }).catch(() => setCopyMsg('复制失败'));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin w-6 h-6 border-2 border-primary-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Alerts */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-600 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 border border-green-100 rounded-lg text-sm text-green-600 flex items-center justify-between">
          <span>{success}</span>
          <button onClick={() => setSuccess('')} className="text-green-400 hover:text-green-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Team Info */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary-600 flex items-center justify-center">
                <Users className="w-5 h-5 text-white" />
              </div>
              <div>
                {editingTeamName ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-bold focus:ring-2 focus:ring-primary-500 outline-none"
                      placeholder="团队名称"
                    />
                    <button onClick={handleUpdateTeam} className="p-1.5 text-green-600 hover:bg-green-50 rounded"><Check className="w-4 h-4" /></button>
                    <button onClick={() => setEditingTeamName(false)} className="p-1.5 text-gray-400 hover:bg-gray-50 rounded"><X className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <h2 className="font-bold text-gray-900 text-lg">{team?.name}</h2>
                )}
                <p className="text-xs text-gray-500 mt-0.5">团队库存管理</p>
              </div>
            </div>
            {isAdmin && !editingTeamName && (
              <button
                onClick={() => { setNewTeamName(team?.name || ''); setEditingTeamName(true); }}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <Edit className="w-3.5 h-3.5" />
                改名
              </button>
            )}
          </div>

          {/* Invite Code */}
          <div className="bg-gray-50 rounded-lg p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 mb-1">团队邀请码</p>
              <code className="text-xl font-mono font-bold tracking-wider text-primary-700">{team?.invite_code}</code>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={copyInvite}
                className="flex items-center gap-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <Copy className="w-3.5 h-3.5" />
                {copyMsg || '复制'}
              </button>
              {isAdmin && (
                <button
                  onClick={handleReInvite}
                  className="p-2 bg-white border border-gray-200 rounded-lg text-gray-400 hover:text-orange-500 transition-colors"
                  title="刷新邀请码"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            其他人可通过邀请码加入你的团队，数据将实时共享
          </p>
        </div>
      </div>

      {/* Members */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
            <Users className="w-4 h-4 text-gray-500" />
            团队成员 ({members.length})
          </h3>
          {isAdmin && !showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded-lg hover:bg-primary-700 transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5" />
              添加成员
            </button>
          )}
        </div>

        {/* Add Member Form */}
        {showAdd && (
          <form onSubmit={handleAddMember} className="p-4 border-b border-gray-100 bg-gray-50/50">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                placeholder="用户名"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 outline-none"
                required
              />
              <input
                type="password"
                placeholder="密码（至少4位）"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 outline-none"
                required
              />
              <input
                type="text"
                placeholder="显示名称（选填）"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 outline-none"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 outline-none bg-white"
              >
                <option value="member">成员</option>
                <option value="admin">管理员</option>
                <option value="viewer">查看者</option>
              </select>
            </div>
            <div className="flex gap-2 mt-3">
              <button type="submit" disabled={addingMember} className="px-4 py-1.5 bg-primary-600 text-white text-xs rounded-lg hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60">
                {addingMember ? '正在添加…' : '确认添加'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAdd(false); setNewUsername(''); setNewPassword(''); setNewDisplayName(''); }}
                className="px-4 py-1.5 border border-gray-300 text-gray-600 text-xs rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </form>
        )}

        {/* Members List */}
        <div className="divide-y divide-gray-100">
          {members.map((m) => {
            const config = ROLE_CONFIG[m.role] || ROLE_CONFIG.viewer;
            const isEditing = editId === m.id;
            const isSelf = m.user_id === user?.id;

            return (
              <div key={m.id} className="p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold ${config.color}`}>
                    {m.display_name?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-900 truncate">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDisplayName}
                            onChange={(e) => setEditDisplayName(e.target.value)}
                            className="px-2 py-1 border rounded text-sm w-32"
                          />
                        ) : (
                          m.display_name
                        )}
                      </span>
                      {isSelf && <Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" title="当前用户" />}
                    </div>
                    {isSelf && <span className="text-xs text-gray-400">（我）</span>}
                    {isEditing ? (
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                        className="ml-2 text-xs border rounded px-1 py-0.5"
                      >
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                        <option value="viewer">查看者</option>
                      </select>
                    ) : (
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ml-2 ${config.color}`}>
                        <config.icon className="w-3 h-3" />
                        {config.label}
                      </span>
                    )}
                  </div>
                </div>

                {isAdmin && !isSelf && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isEditing ? (
                      <>
                        <button onClick={() => handleSaveEdit(m)} className="p-1.5 text-green-600 hover:bg-green-50 rounded">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => { setEditId(null); setEditPwd(''); }} className="p-1.5 text-gray-400 hover:bg-gray-50 rounded">
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setEditId(m.id);
                            setEditDisplayName(m.display_name);
                            setEditRole(m.role);
                            setEditPwd('');
                          }}
                          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleRemove(m.id)}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
