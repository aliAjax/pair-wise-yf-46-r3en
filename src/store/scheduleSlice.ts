import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Role, RundownItem } from "../types";
import { BROADCAST_START, earliestScheduledAt, pinnedMoves } from "../lib/schedule";

export const SCHEDULE_STORAGE_KEY = "pair-wise-yf-46/schedule";

export type ChannelId = "cable" | "mobile" | "satellite";

export interface LocalEdit {
  id: string;
  itemId: string;
  field: string;
  hqValue: string;
  localValue: string;
  note: string;
  at: string;
}

export interface AckRecord {
  id: string;
  version: number;
  at: string;
  accepted: boolean;
  reason?: string;
}

export interface PendingRetry {
  id: string;
  version: number;
  failedAt: string;
  error: string;
}

export interface ChannelState {
  id: ChannelId;
  name: string;
  subscribed: boolean;
  confirmedVersion: number | null;
  inFlightVersion: number | null;
  localEdits: LocalEdit[];
  acks: AckRecord[];
  pendingRetries: PendingRetry[];
}

export interface ProgramVersion {
  version: number;
  items: RundownItem[];
  publishedAt: string;
  publishedBy: Role;
  status: "已发布" | "已作废" | "发布失败";
  note: string;
}

interface ScheduleState {
  versions: ProgramVersion[];
  channels: ChannelState[];
  lastReject: string | null;
}

const CHANNEL_SEED: { id: ChannelId; name: string }[] = [
  { id: "cable", name: "有线网" },
  { id: "mobile", name: "手机端" },
  { id: "satellite", name: "卫星" }
];

function seedChannels(): ChannelState[] {
  return CHANNEL_SEED.map((c) => ({ ...c, subscribed: true, confirmedVersion: null, inFlightVersion: null, localEdits: [], acks: [], pendingRetries: [] }));
}

function loadState(): ScheduleState {
  const fallback: ScheduleState = { versions: [], channels: seedChannels(), lastReject: null };
  try {
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ScheduleState>;
    if (!Array.isArray(parsed.versions) || !Array.isArray(parsed.channels)) return fallback;
    return { versions: parsed.versions, channels: parsed.channels, lastReject: null };
  } catch {
    return fallback;
  }
}

/** 已确认版本集合 / 仍在途（已下发未回执）版本集合。 */
function recomputeStatuses(state: ScheduleState) {
  const confirmed = new Set<number>();
  const active = new Set<number>();
  for (const ch of state.channels) {
    if (ch.confirmedVersion != null) {
      confirmed.add(ch.confirmedVersion);
      active.add(ch.confirmedVersion);
    }
    if (ch.inFlightVersion != null) active.add(ch.inFlightVersion);
  }
  const latest = state.versions.length ? state.versions[state.versions.length - 1].version : 0;
  for (const v of state.versions) {
    if (v.version === latest) v.status = active.has(v.version) ? "已发布" : "发布失败";
    else v.status = confirmed.has(v.version) ? "已发布" : "已作废";
  }
}

/** 最近一个被渠道确认的版本条目；没有则回退到最新版本。 */
function baselineItems(state: ScheduleState): RundownItem[] {
  let confirmed: number | null = null;
  for (const ch of state.channels) if (ch.confirmedVersion != null) confirmed = Math.max(confirmed ?? 0, ch.confirmedVersion);
  if (confirmed != null) {
    const v = state.versions.find((x) => x.version === confirmed);
    if (v) return v.items;
  }
  return state.versions.length ? state.versions[state.versions.length - 1].items : [];
}

/** 模拟渠道下发：约 3 成概率失败，失败后进入待重试队列。 */
function sendOk(): boolean {
  return Math.random() >= 0.28;
}

const slice = createSlice({
  name: "schedule",
  initialState: loadState(),
  reducers: {
    /** 旧数据没有版本号，升级后按发布时间回填初始版本。 */
    backfillInitial(state, action: PayloadAction<RundownItem[]>) {
      if (state.versions.length > 0) return;
      const items = action.payload;
      let publishedAt = new Date().toISOString();
      const earliest = earliestScheduledAt(items);
      if (earliest) {
        const [h, m] = earliest.split(":").map(Number);
        const d = new Date(BROADCAST_START);
        d.setHours(h, m, 0, 0);
        publishedAt = d.toISOString();
      }
      state.versions.push({ version: 1, items: structuredClone(items), publishedAt, publishedBy: "主编", status: "已发布", note: "旧数据回填（原节目单无版本号）" });
      for (const ch of state.channels) {
        ch.confirmedVersion = 1;
        ch.inFlightVersion = null;
      }
      recomputeStatuses(state);
    },

    /** 主编对外发布/替换节目单：作废在途版本并按新版本重发。 */
    publish(state, action: PayloadAction<{ items: RundownItem[]; role: Role; note?: string }>) {
      const { items, role, note } = action.payload;
      if (role !== "主编") {
        state.lastReject = `越权操作已拒绝：仅主编可对外发布/替换节目单（当前岗位：${role}）`;
        return;
      }
      const moves = pinnedMoves(baselineItems(state), items);
      if (moves.length) {
        state.lastReject = `时段不可挪：${moves.map((m) => `「${m.title}」${m.from}→${m.to}`).join("；")}。整点新闻 / 签约广告时段不得挪动，请先恢复再发布。`;
        return;
      }
      state.lastReject = null;
      // 串联单有改动：还没确认的在途版本作废，稍后按新版本重发。
      for (const ch of state.channels) ch.inFlightVersion = null;
      const version = state.versions.length ? state.versions[state.versions.length - 1].version + 1 : 1;
      state.versions.push({ version, items: structuredClone(items), publishedAt: new Date().toISOString(), publishedBy: role, status: "已发布", note: note ?? `发布 v${version}` });
      for (const ch of state.channels) {
        if (!ch.subscribed) continue;
        if (sendOk()) {
          ch.inFlightVersion = version;
          ch.acks.unshift({ id: crypto.randomUUID(), version, at: new Date().toISOString(), accepted: true, reason: "已下发，待渠道回执" });
        } else {
          ch.pendingRetries.unshift({ id: crypto.randomUUID(), version, failedAt: new Date().toISOString(), error: "下发失败：渠道未确认（超时）" });
        }
      }
      recomputeStatuses(state);
    },

    /** 渠道按版本号回执；晚到的回执不能顶掉已确认版本。 */
    ackVersion(state, action: PayloadAction<{ channelId: ChannelId; version: number }>) {
      const ch = state.channels.find((c) => c.id === action.payload.channelId);
      if (!ch) return;
      const { version } = action.payload;
      const at = new Date().toISOString();
      const exists = state.versions.some((v) => v.version === version);
      if (!exists) {
        ch.acks.unshift({ id: crypto.randomUUID(), version, at, accepted: false, reason: "版本不存在" });
        return;
      }
      if (ch.confirmedVersion != null && version <= ch.confirmedVersion) {
        ch.acks.unshift({ id: crypto.randomUUID(), version, at, accepted: false, reason: `晚到回执：已确认 v${ch.confirmedVersion}，v${version} 不可顶` });
        return;
      }
      if (ch.inFlightVersion !== version) {
        ch.acks.unshift({ id: crypto.randomUUID(), version, at, accepted: false, reason: `v${version} 非当前在途版本（在途：v${ch.inFlightVersion ?? "无"}）` });
        return;
      }
      ch.confirmedVersion = version;
      ch.inFlightVersion = null;
      ch.acks.unshift({ id: crypto.randomUUID(), version, at, accepted: true, reason: "已确认" });
      recomputeStatuses(state);
    },

    /** 发布失败后留住待处理项并重试。 */
    retryPending(state, action: PayloadAction<{ channelId: ChannelId; pendingId: string }>) {
      const ch = state.channels.find((c) => c.id === action.payload.channelId);
      if (!ch) return;
      const idx = ch.pendingRetries.findIndex((p) => p.id === action.payload.pendingId);
      if (idx < 0) return;
      const pending = ch.pendingRetries[idx];
      if (sendOk()) {
        ch.inFlightVersion = pending.version;
        ch.pendingRetries.splice(idx, 1);
        ch.acks.unshift({ id: crypto.randomUUID(), version: pending.version, at: new Date().toISOString(), accepted: true, reason: "重试下发成功，待回执" });
      } else {
        pending.failedAt = new Date().toISOString();
        pending.error = "重试仍失败：渠道未确认（超时）";
      }
      recomputeStatuses(state);
    },

    /** 主编作废某渠道在途未确认版本。 */
    voidInFlight(state, action: PayloadAction<ChannelId>) {
      const ch = state.channels.find((c) => c.id === action.payload);
      if (!ch || ch.inFlightVersion == null) return;
      const version = ch.inFlightVersion;
      ch.acks.unshift({ id: crypto.randomUUID(), version, at: new Date().toISOString(), accepted: false, reason: `作废在途版本 v${version}` });
      ch.inFlightVersion = null;
      recomputeStatuses(state);
    },

    toggleSubscribe(state, action: PayloadAction<ChannelId>) {
      const ch = state.channels.find((c) => c.id === action.payload);
      if (!ch) return;
      ch.subscribed = !ch.subscribed;
    },

    /** 渠道自己改过的地方留着：在已确认版本基础上记录本地改动，发布时不覆盖。 */
    addLocalEdit(state, action: PayloadAction<{ channelId: ChannelId; itemId: string; field: string; localValue: string; note: string }>) {
      const ch = state.channels.find((c) => c.id === action.payload.channelId);
      if (!ch) return;
      const baseVersion = ch.confirmedVersion ?? ch.inFlightVersion ?? state.versions[state.versions.length - 1]?.version;
      const hqItem = state.versions.find((v) => v.version === baseVersion)?.items.find((it) => it.id === action.payload.itemId);
      const hqValue = hqItem ? String((hqItem as Record<string, unknown>)[action.payload.field] ?? "") : "";
      ch.localEdits.unshift({ id: crypto.randomUUID(), itemId: action.payload.itemId, field: action.payload.field, hqValue, localValue: action.payload.localValue, note: action.payload.note, at: new Date().toISOString() });
    },

    removeLocalEdit(state, action: PayloadAction<{ channelId: ChannelId; editId: string }>) {
      const ch = state.channels.find((c) => c.id === action.payload.channelId);
      if (!ch) return;
      ch.localEdits = ch.localEdits.filter((e) => e.id !== action.payload.editId);
    },

    clearReject(state) {
      state.lastReject = null;
    }
  }
});

export const { backfillInitial, publish, ackVersion, retryPending, voidInFlight, toggleSubscribe, addLocalEdit, removeLocalEdit, clearReject } = slice.actions;
export default slice.reducer;
