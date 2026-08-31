import { useState, useEffect } from 'react';
import { LayoutDashboard, Package, ArrowDownToLine, ArrowUpFromLine, History, Users, Tag, LogOut, ChevronDown, Crown, Cloud, CloudOff, Wifi, WifiOff, ChartNoAxesCombined, MoreHorizontal, X, Factory } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { getSyncStatus, isSupabaseAvailable } from '../api/client';

const navItems = [
  { id: 'dashboard', label: '库存预览', icon: LayoutDashboard },
  { id: 'products', label: '商品管理', icon: Package },
  { id: 'factory', label: '工厂待出货', icon: Factory },
  { id: 'tags', label: '标签管理', icon: Tag },
  { id: 'stock-in', label: '入库', icon: ArrowDownToLine },
  { id: 'stock-out', label: '出库', icon: ArrowUpFromLine },
  { id: 'movements', label: '变更记录', icon: History },
  { id: 'monitoring', label: '数据监控', icon: ChartNoAxesCombined },
  { id: 'team', label: '团队管理', icon: Users },
];

export default function Layout({ current, onChange, children }) {
  const { user, logout } = useAuth();
  const isViewer = user?.role === 'viewer';
  const visibleNavItems = isViewer
    ? navItems.filter(item => !['stock-in', 'stock-out'].includes(item.id))
    : navItems;
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showMobileMore, setShowMobileMore] = useState(false);
  const [syncState, setSyncState] = useState(getSyncStatus());
  const mobilePrimaryIds = isViewer
    ? ['dashboard', 'products', 'monitoring', 'movements']
    : ['dashboard', 'products', 'stock-in', 'stock-out'];
  const mobilePrimaryItems = visibleNavItems.filter(item => mobilePrimaryIds.includes(item.id));
  const mobileMoreItems = visibleNavItems.filter(item => !mobilePrimaryIds.includes(item.id));
  const moreActive = mobileMoreItems.some(item => item.id === current);

  // 轮询同步状态
  useEffect(() => {
    const update = () => setSyncState(getSyncStatus());
    update();
    const timer = setInterval(update, 5000);
    window.addEventListener('sync:status', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('sync:status', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const syncLabel = !syncState.online
    ? `离线${syncState.pendingCount ? ` · ${syncState.pendingCount}项待同步` : ''}`
    : syncState.migrationStatus === 'running'
      ? '正在合并本机历史数据'
    : syncState.lastError
      ? `同步异常 · ${syncState.pendingCount || 0}项待处理`
      : !syncState.cloudAvailable
        ? '本地模式'
        : syncState.pendingCount
          ? `${syncState.pendingCount}项待同步`
          : syncState.realtimeStatus === 'connected' ? '云端实时同步' : '云端同步';

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:flex-col md:w-60 md:fixed md:inset-y-0 bg-white border-r border-gray-200">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-100">
          <div className="w-10 h-10 rounded-xl bg-primary-600 flex items-center justify-center">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-gray-900 text-sm">库存管理系统</h1>
            <p className="text-xs text-gray-400">{user?.team?.name || 'Inventory'}</p>
          </div>
        </div>

        {/* User Info in Sidebar */}
        <div className="px-3 pt-3 pb-2">
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors text-left"
            >
              <div className="w-7 h-7 rounded-lg bg-primary-100 flex items-center justify-center text-xs font-bold text-primary-700 flex-shrink-0">
                {user?.display_name?.charAt(0)?.toUpperCase() || 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-700 truncate">{user?.display_name}</p>
                <p className="text-[10px] text-gray-400 truncate">
                  {user?.role === 'admin' ? '管理员' : user?.role === 'viewer' ? '查看者' : '成员'}
                </p>
              </div>
              <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
            </button>
            {showUserMenu && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                <button
                  onClick={() => { onChange('team'); setShowUserMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                >
                  <Users className="w-3.5 h-3.5" />
                  团队管理
                </button>
                <button
                  onClick={() => { logout(); setShowUserMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-red-50"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>

        <nav className="flex-1 px-3 pb-3 space-y-1">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const active = current === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary-50 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <Icon className={`w-5 h-5 ${active ? 'text-primary-600' : 'text-gray-400'}`} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-100 space-y-2">
          {/* Sync Status */}
          <div className="flex items-center gap-1.5 justify-center">
            {syncState.online ? (
              syncState.lastError ? (
                <CloudOff className="w-3 h-3 text-red-500" />
              ) : syncState.cloudAvailable ? (
                <Cloud className="w-3 h-3 text-green-500" />
              ) : (
                <Wifi className="w-3 h-3 text-amber-500" />
              )
            ) : (
              <WifiOff className="w-3 h-3 text-red-400" />
            )}
            <span className={`text-[10px] ${
              !syncState.online || syncState.lastError
                ? 'text-red-500'
                : syncState.cloudAvailable ? 'text-green-600' : 'text-amber-600'
            }`}>
              {syncLabel}
            </span>
          </div>
          {syncState.lastError && (
            <p className="text-[10px] text-red-500 text-center line-clamp-2" title={syncState.lastError}>
              {syncState.lastError}
            </p>
          )}
          <p className="text-xs text-gray-400 text-center">v3.0.0</p>
        </div>
      </aside>

      {/* Mobile Header */}
      <header className="md:hidden sticky top-0 z-30 bg-white border-b border-gray-200 flex items-center justify-between"
        style={{ paddingLeft: '16px', paddingRight: '16px', paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: '12px' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center">
            <Package className="w-4 h-4 text-white" />
          </div>
          <h1 className="font-bold text-gray-900 text-sm">库存管理</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-1.5"
          >
            <div className="w-7 h-7 rounded-lg bg-primary-100 flex items-center justify-center text-[10px] font-bold text-primary-700">
              {user?.display_name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
          </button>
        </div>
        {showUserMenu && (
          <div className="absolute top-full right-2 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 w-36">
            <div className="px-3 py-2 border-b border-gray-100">
              <p className="text-xs font-medium text-gray-800">{user?.display_name}</p>
              <p className="text-[10px] text-gray-400">{user?.team?.name}</p>
            </div>
            <button
              onClick={() => { onChange('team'); setShowUserMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
            >
              <Users className="w-3.5 h-3.5" />
              团队管理
            </button>
            <button
              onClick={() => { logout(); setShowUserMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-red-50"
            >
              <LogOut className="w-3.5 h-3.5" />
              退出登录
            </button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 md:ml-60 md:pb-0"
        style={{ paddingTop: '0px', paddingBottom: 'max(80px, calc(60px + env(safe-area-inset-bottom)))' }}
      >
        {!syncState.cloudAvailable && import.meta.env.PROD && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-xs text-amber-800">
            云端同步未配置：当前数据仅保存在本部署服务器，无法保证跨设备同步。
          </div>
        )}
        {syncState.lastError && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-center text-xs text-red-700">
            同步异常：{syncState.lastError}
          </div>
        )}
        {syncState.migrationStatus === 'running' && (
          <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-center text-xs text-blue-700">
            正在安全合并本机历史数据，请保持页面打开和网络连接。
          </div>
        )}
        <div className="max-w-6xl mx-auto p-4 md:p-8">
          {children}
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      {showMobileMore && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/30" onClick={() => setShowMobileMore(false)}>
          <div
            className="absolute inset-x-3 bottom-[76px] rounded-2xl bg-white p-3 shadow-2xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-sm font-semibold text-gray-800">更多功能</p>
              <button type="button" onClick={() => setShowMobileMore(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {mobileMoreItems.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => { onChange(item.id); setShowMobileMore(false); }}
                    className={`flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-xs font-medium ${current === item.id ? 'bg-primary-50 text-primary-600' : 'bg-gray-50 text-gray-600'}`}
                  >
                    <Icon className="h-5 w-5" />{item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 flex items-center justify-around z-50"
        style={{ paddingBottom: 'max(4px, env(safe-area-inset-bottom))', paddingTop: '4px', paddingLeft: '2px', paddingRight: '2px' }}
      >
        {mobilePrimaryItems.map((item) => {
          const Icon = item.icon;
          const active = current === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={`flex flex-col items-center gap-0.5 px-0.5 py-1.5 rounded-lg transition-colors min-w-0 flex-1 ${
                active ? 'text-primary-600' : 'text-gray-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium truncate">{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowMobileMore(currentValue => !currentValue)}
          className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1.5 transition-colors ${moreActive || showMobileMore ? 'text-primary-600' : 'text-gray-400'}`}
        >
          <MoreHorizontal className="h-5 w-5" />
          <span className="text-[10px] font-medium">更多</span>
        </button>
      </nav>
    </div>
  );
}
