import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { X, Camera, ScanLine, Keyboard, AlertTriangle } from 'lucide-react';

const CAMERA_GRANTED_KEY = 'inventory_camera_granted';

const isStandaloneApp = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

const cameraGrantedKey = () =>
  `${CAMERA_GRANTED_KEY}_${isStandaloneApp() ? 'standalone' : 'browser'}`;

export default function BarcodeScanner({ onScan, onClose }) {
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [isSecureContext, setIsSecureContext] = useState(true);
  const [isStandalone] = useState(isStandaloneApp);
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const lastScanRef = useRef('');
  const scanTimeoutRef = useRef(null);
  const startedRef = useRef(false);

  const stopCamera = () => {
    if (controlsRef.current) {
      try { controlsRef.current.stop(); } catch (e) {}
      controlsRef.current = null;
    }
    if (videoRef.current?.srcObject) {
      for (const track of videoRef.current.srcObject.getTracks()) track.stop();
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
    setScanning(false);
  };

  // 检查是否为安全上下文（HTTPS 或 localhost）
  useEffect(() => {
    const secure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    setIsSecureContext(secure);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const startCamera = async () => {
    stopCamera();
    setError('');
    setScanning(true);
    startedRef.current = true;

    // 非安全上下文检测
    if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      setError('摄像头仅支持 HTTPS 或本地访问。请使用 HTTPS 连接打开此页面。');
      setScanning(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持摄像头访问，请升级浏览器或使用手动输入。');
      setScanning(false);
      return;
    }

    const permissionsPolicy = document.permissionsPolicy || document.featurePolicy;
    if (permissionsPolicy?.allowsFeature && !permissionsPolicy.allowsFeature('camera')) {
      setError('当前页面禁止调用摄像头。请直接在浏览器中打开此应用链接；若页面嵌在其他应用中，需要为嵌入页面开启 camera 权限。');
      setScanning(false);
      return;
    }

    try {
      const reader = new BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: 200,
        delayBetweenScanSuccess: 500,
      });
      readerRef.current = reader;

      // 直接请求后置摄像头，使授权请求发生在用户点击事件中；避免部分手机在
      // 首次授权前 enumerateDevices 返回空设备或不可用 deviceId。
      const controls = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        videoRef.current,
        (result, err) => {
          if (result) {
            const code = result.getText();
            // Prevent duplicate scans within 1.5s
            if (code !== lastScanRef.current) {
              lastScanRef.current = code;
              if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
              scanTimeoutRef.current = setTimeout(() => {
                lastScanRef.current = '';
              }, 1500);
              if (controlsRef.current) {
                try { controlsRef.current.stop(); } catch (e) {}
              }
              onScan(code);
            }
          }
          if (err && !(err.name === 'NotFoundException')) {
            console.warn('Scan error:', err);
          }
        }
      );
      controlsRef.current = controls;
      try { localStorage.setItem(cameraGrantedKey(), 'true'); } catch (e) {}
      setCameraReady(true);
    } catch (err) {
      console.error('Camera access error:', err);
      const msg = (err.message || '').toLowerCase();
      const errName = (err.name || '').toLowerCase();

      if (errName === 'notallowederror' || errName === 'permissiondeniederror' ||
          msg.includes('notallowed') || msg.includes('permission') ||
          msg.includes('not allowed') || msg.includes('denied')) {
        try { localStorage.removeItem(cameraGrantedKey()); } catch (e) {}
        setError(isStandaloneApp()
          ? '桌面 Web App 的摄像头权限未开启。请前往 iPhone「设置 > 隐私与安全性 > 相机」允许此 Web App，然后返回并点击重试；桌面版权限与 Safari 页面需要分别授权。'
          : '摄像头权限被拒绝。请在浏览器的网站设置中将“摄像头”改为允许，然后刷新页面重试；微信等内置浏览器请使用系统浏览器直接打开链接。');
      } else if (msg.includes('notfound') || msg.includes('device') || msg.includes('no camera')) {
        setError('未找到可用的摄像头设备');
      } else if (msg.includes('secure') || msg.includes('https') || errName === 'securityerror') {
        setError('摄像头需要 HTTPS 安全连接。请确认页面使用 HTTPS 访问。');
      } else {
        setError('无法启动摄像头: ' + (err.message?.slice(0, 60) || '未知错误，请尝试手动输入'));
      }
      setScanning(false);
    }
  };

  // 首次仍由用户点击并授权；成功授权后，再进入扫码页时自动启动。
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      let granted = false;
      try {
        if (navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: 'camera' });
          // 主屏幕 Web App 首次必须依靠自己的成功记录，不能复用 Safari 对
          // 同源页面返回的 granted 状态，否则 iOS 可能在无用户手势时拒绝。
          granted = !isStandaloneApp() && status.state === 'granted';
        }
      } catch (e) {
        // Safari 暂不支持查询 camera 权限，使用上次成功记录兜底。
      }
      try {
        // Safari 页面和添加到主屏幕的 Web App 分别记录，避免桌面版首次启动
        // 误用浏览器页面的记录，在没有用户手势时触发权限拒绝。
        granted = granted || localStorage.getItem(cameraGrantedKey()) === 'true';
      } catch (e) {}
      if (!cancelled && granted && !startedRef.current) startCamera();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // 清理资源
  useEffect(() => {
    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      if (controlsRef.current) try { controlsRef.current.stop(); } catch (e) {}
    };
  }, []);

  const handleClose = () => {
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    stopCamera();
    onClose();
  };

  const openManualMode = () => {
    stopCamera();
    setManualMode(true);
  };

  const returnToScanner = () => {
    setManualMode(false);
    setError('');
    startedRef.current = false;
  };

  const handleManualSubmit = (e) => {
    e.preventDefault();
    const code = manualCode.trim();
    if (!code) return;
    onScan(code);
  };

  if (manualMode) {
    return createPortal(
      <div className="fixed inset-0 z-[100] w-screen bg-white flex flex-col overflow-hidden" style={{ height: '100dvh', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2 text-gray-900">
            <Keyboard className="w-5 h-5" />
            <span className="font-medium">手动输入条形码</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={returnToScanner}
              className="px-3 py-1.5 text-sm text-primary-600 hover:bg-primary-50 rounded-lg"
            >
              <ScanLine className="w-4 h-4 inline mr-1" />
              扫码
            </button>
            <button onClick={handleClose} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <form onSubmit={handleManualSubmit} className="w-full max-w-sm space-y-4">
            <div className="text-center mb-2">
              <Keyboard className="w-12 h-12 mx-auto text-gray-300 mb-2" />
              <p className="text-sm text-gray-500">输入条形码编号后按回车确认</p>
            </div>
            <input
              className="input text-center text-lg font-mono tracking-wider"
              placeholder="输入条形码"
              value={manualCode}
              onChange={e => setManualCode(e.target.value)}
              autoFocus
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              className="btn-primary w-full"
            >
              确认
            </button>
          </form>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] w-screen bg-black flex flex-col overflow-hidden" style={{ height: '100dvh', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center justify-between px-4 py-3 bg-black/50 z-10 shrink-0">
        <div className="flex items-center gap-2 text-white">
          <ScanLine className="w-5 h-5" />
          <span className="font-medium">扫描条形码</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openManualMode}
            className="px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 rounded-lg flex items-center gap-1"
          >
            <Keyboard className="w-4 h-4" />
            手动输入
          </button>
          <button onClick={handleClose} className="p-2 text-white hover:bg-white/10 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden bg-black">
        {/* Camera video */}
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          autoPlay
          muted
        />

        {/* Scan frame overlay */}
        {scanning && cameraReady && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-64 h-40 max-w-[80%]">
              <div className="absolute inset-0 border-2 border-white/30 rounded-xl" />
              <div className="absolute inset-0 border-2 border-primary-400 rounded-xl overflow-hidden">
                <div className="absolute left-0 right-0 h-0.5 bg-primary-400 shadow-[0_0_8px_2px_rgba(59,130,246,0.6)] animate-scan" />
              </div>
              {/* Corner markers */}
              <div className="absolute top-[-2px] left-[-2px] w-6 h-6 border-t-[3px] border-l-[3px] border-primary-400 rounded-tl-xl" />
              <div className="absolute top-[-2px] right-[-2px] w-6 h-6 border-t-[3px] border-r-[3px] border-primary-400 rounded-tr-xl" />
              <div className="absolute bottom-[-2px] left-[-2px] w-6 h-6 border-b-[3px] border-l-[3px] border-primary-400 rounded-bl-xl" />
              <div className="absolute bottom-[-2px] right-[-2px] w-6 h-6 border-b-[3px] border-r-[3px] border-primary-400 rounded-br-xl" />
            </div>
          </div>
        )}

        {/* Not started yet - show start button */}
        {!startedRef.current && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8">
            <div className="w-20 h-20 rounded-full bg-primary-500/20 flex items-center justify-center mb-2">
              <Camera className="w-10 h-10 text-primary-400" />
            </div>
            <p className="text-white/80 text-sm text-center max-w-xs">
              {isStandalone
                ? '首次从桌面打开时，需要单独允许此 Web App 使用摄像头'
                : '点击下方按钮启动摄像头进行扫码'}
            </p>
            {!isSecureContext && (
              <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg max-w-xs">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-amber-300 text-xs">
                  当前页面为非安全上下文，摄像头可能无法使用。建议使用 HTTPS 或手机本地访问。
                </p>
              </div>
            )}
            <button
              onClick={startCamera}
              className="px-8 py-3 bg-primary-600 text-white rounded-xl text-base font-medium hover:bg-primary-700 active:scale-95 transition-all shadow-lg shadow-primary-600/30"
            >
              <Camera className="w-5 h-5 inline mr-2" />
              {isStandalone ? '允许并启动摄像头' : '启动摄像头'}
            </button>
          </div>
        )}

        {/* Loading / waiting for camera */}
        {scanning && !cameraReady && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
            <p className="text-white/70 text-sm">正在启动摄像头...</p>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center bg-black/90">
            <Camera className="w-12 h-12 text-gray-500" />
            <p className="text-white text-sm max-w-xs leading-relaxed">{error}</p>
            <div className="flex gap-2 flex-wrap justify-center">
              <button
                onClick={handleClose}
                className="px-4 py-2 bg-white/10 text-white text-sm rounded-lg hover:bg-white/20"
              >
                返回
              </button>
              <button
                onClick={openManualMode}
                className="px-4 py-2 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700"
              >
                <Keyboard className="w-4 h-4 inline mr-1" />
                手动输入
              </button>
              <button
                onClick={startCamera}
                className="px-4 py-2 bg-white/10 text-white text-sm rounded-lg hover:bg-white/20"
              >
                重试
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4 text-center bg-black/50 z-10 shrink-0">
        <p className="text-white/70 text-sm">
          {cameraReady
            ? '将条形码对准框内即可自动扫描'
            : startedRef.current && scanning
              ? '正在连接摄像头...'
              : '点击「启动摄像头」开始扫码'}
        </p>
      </div>

      <style>{`
        @keyframes scan {
          0%, 100% { top: 0; }
          50% { top: calc(100% - 4px); }
        }
        .animate-scan {
          animation: scan 2s ease-in-out infinite;
        }
      `}</style>
    </div>,
    document.body
  );
}
