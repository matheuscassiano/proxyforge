import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import { useApp } from "../lib/store";
import type { PageMap } from "../lib/types";

// One request per deck/layout change, shared by every component that asks.
let lastKey = "";
let lastValue: PageMap[] = [];
let inflight: Promise<PageMap[]> | null = null;

/** Pages of the live view with each card copy's position (blank sheets excluded). */
export function usePageMap(): PageMap[] {
  const project = useApp((s) => s.project);
  const cards = project?.cards;
  const layout = project?.layout;
  const key = JSON.stringify([cards?.map((c) => [c.id, c.qty, c.back ?? null]), layout]);
  const [map, setMap] = useState<PageMap[]>(() => (key === lastKey ? lastValue : []));

  useEffect(() => {
    const p = useApp.getState().project;
    if (!p) return setMap([]);
    if (key === lastKey && !inflight) return setMap(lastValue);
    let alive = true;
    if (key !== lastKey || !inflight) {
      lastKey = key;
      inflight = api.pageMap(p).then(
        (m) => {
          lastValue = m;
          inflight = null;
          return m;
        },
        () => {
          inflight = null;
          return lastValue;
        },
      );
    }
    inflight?.then((m) => alive && setMap(m));
    return () => {
      alive = false;
    };
  }, [key]);

  return map;
}
