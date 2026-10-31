import { useEffect, useRef, useState } from "react";
import type { CallDetail, SessionDetail, SessionSummary } from "../shared/types";

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export const api = {
  sessions: () => get<{ logsDir: string; sessions: SessionSummary[] }>("/api/sessions"),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  call: (sid: string, cid: string) =>
    get<CallDetail>(`/api/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(cid)}`),
};

export type LiveEvent = { ids: string[]; sessions: string[]; at: number };

/** Subscribes to new captures. Returns the latest event and connection state. */
export function useLive(): { connected: boolean; last: LiveEvent | null } {
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<LiveEvent | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => setLast({ ...JSON.parse(e.data), at: Date.now() });
    return () => es.close();
  }, []);
  return { connected, last };
}

/** Fetch helper that re-runs when deps change, keeping the previous value while loading. */
export function useData<T>(fn: () => Promise<T> | null, deps: unknown[]): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const p = fn();
    if (!p) {
      setData(null);
      return;
    }
    const n = ++seq.current;
    p.then(
      (d) => n === seq.current && (setData(d), setError(null)),
      (e) => n === seq.current && setError(String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

/** Hash routing: #/<sessionId>/<callId?> */
export function useRoute(): [{ session: string | null; call: string | null }, (s: string | null, c?: string | null) => void] {
  const parse = () => {
    const [, s, c] = location.hash.replace(/^#/, "").split("/");
    return { session: s ? decodeURIComponent(s) : null, call: c ? decodeURIComponent(c) : null };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (s: string | null, c: string | null = null) => {
    location.hash = s ? `/${encodeURIComponent(s)}${c ? `/${encodeURIComponent(c)}` : ""}` : "";
  };
  return [route, go];
}
