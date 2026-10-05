import { addMinutes, format } from "date-fns";
import type { RundownItem } from "../types";

export const BROADCAST_START = new Date("2026-10-08T08:00:00");

/** 串联单每条条目的计划播出时刻（HH:mm），按当前顺序顺延。 */
export function scheduledMap(items: RundownItem[]): Map<string, string> {
  const map = new Map<string, string>();
  let cursor = new Date(BROADCAST_START);
  for (const item of items) {
    map.set(item.id, format(cursor, "HH:mm"));
    cursor = addMinutes(cursor, item.duration);
  }
  return map;
}

/**
 * 锁定时段：整点新闻（hardStart 落在整点）与签约广告（带 hardStart 的广告）。
 * 这些时段在对账中不允许被挪动。
 */
export function isPinned(item: RundownItem): boolean {
  if (!item.hardStart) return false;
  if (item.type === "广告") return true;
  return item.hardStart.endsWith(":00");
}

/** 对比两个版本，返回被挪动的锁定时段（整点新闻 / 签约广告）。 */
export function pinnedMoves(prev: RundownItem[], next: RundownItem[]): { id: string; title: string; from: string; to: string }[] {
  const prevMap = scheduledMap(prev);
  const nextMap = scheduledMap(next);
  const moves: { id: string; title: string; from: string; to: string }[] = [];
  for (const item of prev.filter(isPinned)) {
    const from = prevMap.get(item.id);
    const to = nextMap.get(item.id);
    if (from !== to) moves.push({ id: item.id, title: item.title, from: from ?? "--", to: to ?? "--" });
  }
  return moves;
}

/** 取最早的计划时刻，用于旧数据按发布时间回填初始版本。 */
export function earliestScheduledAt(items: RundownItem[]): string | null {
  const map = scheduledMap(items);
  let earliest: string | null = null;
  for (const t of map.values()) if (!earliest || t < earliest) earliest = t;
  return earliest;
}
