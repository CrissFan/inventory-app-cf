import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import StockIn from './pages/StockIn';
import StockOut from './pages/StockOut';
import Movements from './pages/Movements';
import Team from './pages/Team';
import Tags from './pages/Tags';
import Monitoring from './pages/Monitoring';
import Login from './pages/Login';

function AppContent() {
  const { user, loading } = useAuth();
  const [page, setPage] = useState('dashboard');
  const [pageParams, setPageParams] = useState(null);

  const navigate = (nextPage, params = null) => {
    setPage(nextPage);
    setPageParams(params);
  };

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [page, pageParams]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-gray-500">加载中...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const isViewer = user?.role === 'viewer';

  const renderPage = () => {
    const content = (() => {
      switch (page) {
        case 'dashboard': return <Dashboard onNavigate={navigate} canManage={!isViewer} />;
        case 'products': return <Products />;
        case 'stock-in': return isViewer ? <NoAccess /> : <StockIn initialSelection={pageParams} />;
        case 'stock-out': return isViewer ? <NoAccess /> : <StockOut />;
        case 'movements': return <Movements />;
        case 'tags': return <Tags />;
        case 'monitoring': return <Monitoring />;
        case 'team': return <Team />;
        default: return <Dashboard onNavigate={navigate} canManage={!isViewer} />;
      }
    })();

    return (
      <ErrorBoundary key={page} onBack={() => navigate('dashboard')}>
        {content}
      </ErrorBoundary>
    );
  };

  return (
    <Layout current={page} onChange={navigate}>
      {renderPage()}
    </Layout>
  );
}

function NoAccess() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-gray-400">
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>
      <p className="text-sm font-medium">权限不足</p>
      <p className="text-xs mt-1">查看者无法进行出入库操作</p>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
