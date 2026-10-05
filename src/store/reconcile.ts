import type {
  ChannelId,
  ChannelOverride,
  ChannelState,
  Publish,
  RundownItem,
  ScheduleDiff,
  ScheduleEntry
} from "../types";
import { isLockedSlot } from "../types";

export const CHANNELS: { id: ChannelId; name: string }[] = [
  { id: "cable", name: "有线网" },
  { id: "mobile", name: "手机端" },
  { id: "satellite", name: "卫星" }
];

export function channelName(id: ChannelId): string {
  return CHANNELS.find((channel) => channel.id === id)?.name ?? id;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function minutesToHHMM(offset: number): string {
  return `${pad2(8 + Math.floor(offset / 60))}:${pad2(offset % 60)}`;
}

export function hhmmToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/**
 * 重算时间轴：锁点（整点新闻、签约广告等带 hardStart 的条目）一律钉在硬开点，
 * 插播、调时长、拖拽都不能挪动锁点；锁点之后的非锁点条目从锁点窗口结束处顺延。
 * 若前面的非锁点内容与锁点窗口重叠，锁点仍不动，由 scheduleConflicts 暴露风险。
 */
export function buildEntries(items: RundownItem[]): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  let cursor = 0; // 距开播分钟数
  for (const item of items) {
    if (isLockedSlot(item) && item.hardStart) {
      const hard = hhmmToMinutes(item.hardStart) - 8 * 60;
      entries.push(toEntry(item, hard));
      cursor = hard + item.duration;
    } else {
      entries.push(toEntry(item, cursor));
      cursor += item.duration;
    }
  }
  return entries;
}

/** 与锁点窗口重叠的非锁点条目（锁点永远不背风险锅），即硬时间风险 */
export function scheduleConflicts(entries: ScheduleEntry[]): ScheduleEntry[] {
  const conflicts = new Set<string>();
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      const aStart = hhmmToMinutes(a.start);
      const bStart = hhmmToMinutes(b.start);
      if (aStart < bStart + b.duration && bStart < aStart + a.duration) {
        if (!a.locked) conflicts.add(a.id);
        if (!b.locked) conflicts.add(b.id);
      }
    }
  }
  return entries.filter((entry) => conflicts.has(entry.id));
}

/** 去掉会随时间变化的字段后做内容指纹，内容相同则不必重发 */
export function hashEntries(entries: ScheduleEntry[]): string {
  const body = entries
    .map((entry) => `${entry.itemId}:${entry.title}:${entry.type}:${entry.start}:${entry.duration}`)
    .join("|");
  let hash = 0;
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

function toEntry(item: RundownItem, offset: number): ScheduleEntry {
  return {
    id: `e-${item.id}`,
    itemId: item.id,
    title: item.title,
    type: item.type,
    start: minutesToHHMM(offset),
    duration: item.duration,
    locked: isLockedSlot(item)
  };
}

export function applyOverrides(entries: ScheduleEntry[], overrides: ChannelOverride[]): ScheduleEntry[] {
  return entries.map((entry) => {
    const override = overrides.find((candidate) => candidate.itemId === entry.itemId);
    return override
      ? { ...entry, title: override.title, duration: override.duration }
      : entry;
  });
}

/**
 * 对账：渠道自改的地方保留（新版本不覆盖），单独列出差异。
 * - 保留差异：同一条目渠道标题/时长与台里不一致
 * - 条目缺失：台里新版本有、渠道侧没有（渠道不能擅自删，列出待主编定夺）
 */
export function diffAgainstChannel(publish: Publish, channel: ChannelState): ScheduleDiff[] {
  const local = applyOverrides(publish.entries, channel.overrides);
  const diffs: ScheduleDiff[] = [];
  for (const stationEntry of publish.entries) {
    const localEntry = local.find((entry) => entry.itemId === stationEntry.itemId);
    if (!localEntry) {
      diffs.push({ itemId: stationEntry.itemId, entryId: stationEntry.id, stationTitle: stationEntry.title, channelTitle: "（渠道缺失）", status: "条目缺失" });
      continue;
    }
    if (localEntry.title !== stationEntry.title || localEntry.duration !== stationEntry.duration) {
      diffs.push({ itemId: stationEntry.itemId, entryId: stationEntry.id, stationTitle: stationEntry.title, channelTitle: localEntry.title, status: "保留差异" });
    }
  }
  return diffs;
}

/** 渠道本地对外展示的节目单 = 已确认的最新版本 + 渠道自改 */
export function channelView(publishes: Publish[], channel: ChannelState): ScheduleEntry[] {
  const confirmed = [...publishes]
    .filter((publish) => publish.sends.some((send) => send.channelId === channel.id && send.status === "已确认"))
    .sort((a, b) => b.version - a.version)[0];
  if (!confirmed) return [];
  return applyOverrides(confirmed.entries, channel.overrides);
}

/** 在途（未确认）或发布失败待重试的发送渠道 */
export function pendingSends(publish: Publish): ChannelId[] {
  return publish.sends.filter((send) => send.status === "在途" || send.status === "发布失败").map((send) => send.channelId);
}
