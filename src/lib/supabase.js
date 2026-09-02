import { createClient } from '@supabase/supabase-js';

// Supabase 配置 (通过 Vite 环境变量注入)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// 检查是否已配置 Supabase
const isConfigured = !!(supabaseUrl && supabaseAnonKey);

let supabase = null;

if (isConfigured) {
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

/**
 * 获取 Supabase 客户端实例
 * 如果未配置则返回 null
 */
export function getSupabase() {
  return supabase;
}

/**
 * Supabase 是否可用
 */
export function isSupabaseAvailable() {
  return isConfigured && supabase !== null;
}

// 创建成员时使用独立的临时 Auth 客户端，避免 signUp 切换当前管理员会话。
export function createEphemeralSupabase() {
  if (!isConfigured) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export { supabase };
