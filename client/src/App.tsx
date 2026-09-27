import { useEffect, useMemo, useState } from 'react';
import { Inspector } from './components/Inspector';
import { CaptureSessionWorkspace } from './components/CaptureSessionWorkspace';
import { isDuplicateFrame, useCaptureSession } from './useCaptureSession';
import type { SimulatedPacket } from '../../shared/types';

type WorkspaceMode = 'inspector' | 'session';

function App() {
  const [mode, setMode] = useState<WorkspaceMode>('inspector');
  const sessionApi = useCaptureSession();
  const { session, notice, capturing } = sessionApi;

  // 重新打开页面：恢复最近一次会话；恢复到了就直接进入会话工作区
  useEffect(() => {
    let cancelled = false;
    void sessionApi.restore().then((restoredSession) => {
      if (cancelled) return;
      if (restoredSession) setMode('session');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 当前解析工作台展示的 packet，用于“该结果已在会话中”的重复提示
  const [inspectorPacket, setInspectorPacket] = useState<SimulatedPacket | null>(null);
  const duplicate = useMemo(
    () => isDuplicateFrame(session, inspectorPacket),
    [session, inspectorPacket]
  );

  const frameCount = session?.frames.length ?? 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <nav className="mode-switch" aria-label="工作区切换">
        <button className={mode === 'inspector' ? 'active' : ''} onClick={() => setMode('inspector')}>
          <span className="mode-icon">⌖</span> 解析工作台
        </button>
        <button className={mode === 'session' ? 'active' : ''} onClick={() => setMode('session')}>
          <span className="mode-icon">▤</span> 捕获会话
          <span className={`mode-badge ${frameCount ? 'has-frames' : ''}`}>{frameCount}</span>
        </button>
      </nav>

      <main className="dashboard">
        {mode === 'inspector' && (
          <>
            <Inspector
              capturing={capturing}
              hasSession={Boolean(session)}
              duplicate={duplicate}
              onPacketChange={setInspectorPacket}
              onCapture={(packet) => {
                void sessionApi.capture(packet);
              }}
              onCreateSession={() => { void sessionApi.createSession(); }}
              onOpenSession={() => setMode('session')}
            />
            {notice && (
              <div className="notice-banner capture-notice">
                ✓ {notice.text}
                <button className="button ghost inline" onClick={() => setMode('session')}>前往查看 →</button>
                <button onClick={sessionApi.clearNotice}>关闭</button>
              </div>
            )}
            {sessionApi.actionError && (
              <div className="error-banner capture-notice">
                ⚠ {sessionApi.actionError}
                <button onClick={sessionApi.clearActionError}>关闭</button>
              </div>
            )}
          </>
        )}

        {mode === 'session' && (
          <CaptureSessionWorkspace
            sessionApi={sessionApi}
            onGoInspector={() => setMode('inspector')}
            onRetryRestore={() => { void sessionApi.restore(); }}
          />
        )}
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

export default App;
