import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getMe, getSavedUser, logout as apiLogout, initSync } from './api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check auth on mount
  useEffect(() => {
    const saved = getSavedUser();
    if (saved) {
      // Verify token/Supabase session is still valid
      getMe()
        .then((data) => {
          setUser(data.user);
          // 初始化同步引擎
          initSync();
        })
        .catch(() => { apiLogout(); setUser(null); })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  // Listen for forced logout events
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, []);

  const login = useCallback((userData) => {
    setUser(userData);
    // 登录成功后建立 Realtime 订阅，并安全合并本机历史数据。
    initSync().catch(() => {});
  }, []);

  const logout = useCallback(() => {
    apiLogout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isAuth: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
