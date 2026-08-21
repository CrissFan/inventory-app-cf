import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-6">
          <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mb-4">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">页面出错了</h2>
          <p className="text-sm text-gray-500 text-center max-w-md mb-1">
            {this.state.error?.message || '发生了未知错误'}
          </p>
          {this.state.error?.stack && (
            <details className="mt-3 w-full max-w-lg">
              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">查看详细错误</summary>
              <pre className="mt-2 p-3 bg-gray-100 rounded-lg text-xs text-gray-600 overflow-auto max-h-40 whitespace-pre-wrap">
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button
            onClick={this.handleReset}
            className="mt-5 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 inline-flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            重试
          </button>
          {this.props.onBack && (
            <button
              onClick={this.props.onBack}
              className="mt-2 px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              返回首页
            </button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
