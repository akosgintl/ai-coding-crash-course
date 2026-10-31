import { useEffect, useState } from "react";
import { api, useData, useLive, useRoute } from "./api";
import { SessionList } from "./components/SessionList";
import { SessionView } from "./components/SessionView";
import { CallInspector } from "./components/CallInspector";

export function App() {
  const [route, go] = useRoute();
  const live = useLive();
  // Off by default: a capture in another session refreshes the list silently instead of stealing focus.
  const [follow, setFollowState] = useState(() => localStorage.getItem("followLive") === "1");
  const setFollow = (on: boolean) => {
    localStorage.setItem("followLive", on ? "1" : "0");
    setFollowState(on);
  };
  const tick = live.last?.at ?? 0;

  const sessions = useData(() => api.sessions(), [tick]);
  const list = sessions.data?.sessions ?? [];

  // Follow mode: jump to the session that just received a capture.
  useEffect(() => {
    if (!follow || !live.last?.sessions.length) return;
    const sid = live.last.sessions[live.last.sessions.length - 1];
    if (sid !== route.session) go(sid, route.call && route.session === sid ? route.call : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.last]);

  // Default to the most recent session.
  useEffect(() => {
    if (!route.session && list.length) go(list[0].sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  const sessionLive = !!route.session && !!live.last?.sessions.includes(route.session);
  const session = useData(() => (route.session ? api.session(route.session) : null), [route.session, sessionLive ? tick : 0]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Harness Inspector <span className="muted">· request-logger</span>
        </div>
        <div className="topbar-right">
          <label className="follow" title="Jump to the session that receives a new capture">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow live
          </label>
          <span className={`live-dot ${live.connected ? "on" : ""}`} />
          <span className="muted">{live.connected ? "watching" : "disconnected"}</span>
          <span className="muted path" title={sessions.data?.logsDir}>{sessions.data?.logsDir}</span>
        </div>
      </header>
      <div className="layout">
        <SessionList sessions={list} selected={route.session} onSelect={(id) => go(id)} liveSessions={live.last?.sessions ?? []} />
        <main className="main">
          {sessions.error && <div className="error">{sessions.error}</div>}
          {session.data ? (
            <SessionView
              session={session.data}
              selectedCall={route.call}
              onSelectCall={(cid) => go(session.data!.sessionId, cid)}
              freshIds={live.last?.ids ?? []}
            />
          ) : (
            <div className="empty">{list.length ? "Select a session" : "No captures yet — run the request-logger and use your agent."}</div>
          )}
        </main>
        {route.session && route.call && (
          <CallInspector sessionId={route.session} callId={route.call} onClose={() => go(route.session)} />
        )}
      </div>
    </div>
  );
}
