import { createSlice, current, type PayloadAction } from "@reduxjs/toolkit";
import type {
  BreakingChange,
  ChannelEvent,
  ChannelEventKind,
  ChannelId,
  ChannelOverride,
  ChannelSend,
  ChannelState,
  HistoryEntry,
  PendingChange,
  Publish,
  Role,
  RundownItem
} from "../types";
import { isLockedSlot } from "../types";
import { buildEntries, CHANNELS, hashEntries } from "./reconcile";

/** 旧节目单（无版本号数据）的发布时间，升级时按它回填初始版本 */
export const LEGACY_PUBLISHED_AT = "2026-10-08T07:30:00";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点签约广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" },
  { id: "r5", title: "整点新闻", type: "新闻片", duration: 10, hardStart: "09:00", status: "待播", presenter: "陈默", source: "主控" }
];

function backfilledPublish(items: RundownItem[], publishedAt: string): Publish {
  const entries = buildEntries(items);
  return {
    version: 1,
    publishedAt,
    reason: "旧数据无版本号，升级后按发布时间回填初始版本",
    entries,
    hash: hashEntries(entries),
    backfilled: true,
    sends: CHANNELS.map<ChannelSend>(({ id }) => ({
      channelId: id,
      status: "已确认",
      sentAt: publishedAt,
      confirmedAt: publishedAt,
      attempts: 1
    }))
  };
}

function initialChannels(): ChannelState[] {
  return CHANNELS.map(({ id, name }) => ({ id, name, version: 1, overrides: [] }));
}

interface State {
  initialized: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  role: Role;
  online: boolean;
  /* 对外节目单对账 */
  publishes: Publish[];
  channels: ChannelState[];
  epgLog: ChannelEvent[];
}

function makeLog(kind: ChannelEventKind, detail: string, channelId?: ChannelId): ChannelEvent {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), kind, detail, channelId };
}

function logEvent(state: State, kind: ChannelEventKind, detail: string, channelId?: ChannelId) {
  state.epgLog.unshift(makeLog(kind, detail, channelId));
}

function createInitialState(): State {
  return {
    initialized: false,
    items: seed,
    history: [],
    queue: [],
    changes: [],
    role: "导播",
    online: true,
    publishes: [backfilledPublish(seed, LEGACY_PUBLISHED_AT)],
    channels: initialChannels(),
    epgLog: [makeLog("版本回填", `旧节目单无版本号，按发布时间回填为 v1，三个渠道初始确认（${LEGACY_PUBLISHED_AT.replace("T", " ")}）`)]
  };
}

const initialState = createInitialState();

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(current(items)) };
}

function latestPublish(state: State): Publish | undefined {
  return [...state.publishes].sort((a, b) => b.version - a.version)[0];
}

/** 渠道当前已确认的版本号（跨所有发布找最新确认） */
function confirmedVersion(state: State, channelId: ChannelId): number | null {
  const versions = state.publishes
    .filter((publish) => publish.sends.some((send) => send.channelId === channelId && send.status === "已确认"))
    .map((publish) => publish.version);
  return versions.length ? Math.max(...versions) : null;
}

/** 只有主编能对外发布和替换；其他岗越权直接拒绝并留审计 */
function denyUnlessEditor(state: State, action: string): boolean {
  if (state.role === "主编") return true;
  logEvent(state, "越权拒绝", `${state.role}尝试「${action}」已拒绝：仅主编可对外发布/替换`);
  return false;
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<{ legacy: boolean; items: RundownItem[]; publishes?: Publish[]; channels?: ChannelState[] }>) {
      if (state.initialized) return;
      state.initialized = true;
      const payload = action.payload;
      if (!payload.legacy && payload.publishes && payload.channels) {
        state.items = payload.items;
        state.publishes = payload.publishes;
        state.channels = payload.channels;
        return;
      }
      // 旧数据：没有版本号，按发布时间回填初始版本，渠道按已确认处理
      const items = payload.items.length ? payload.items : seed;
      state.items = items;
      state.publishes = [backfilledPublish(items, LEGACY_PUBLISHED_AT)];
      state.channels = initialChannels();
      logEvent(state, "版本回填", "检测到无版本号旧节目单，已按发布时间回填 v1 并置为渠道已确认");
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿" });
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      // 整点新闻、签约广告等锁点时段不挪：锁点条目的位置必须保持不变
      const before = new Map(state.items.map((item, index) => [item.id, index]));
      const movedLocked = action.payload.filter((item, index) => isLockedSlot(item) && before.get(item.id) !== index);
      if (movedLocked.length) {
        logEvent(state, "锁点拦截", `拖拽调整被拒绝：${movedLocked.map((item) => item.title).join("、")} 为锁点时段不可挪动`);
        return;
      }
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const index = state.items.findIndex((item) => item.id === change.insertAfter);
      state.history.unshift(snapshot(state.items, "突发插播", change.headline));
      state.items.splice(index + 1, 0, { id: crypto.randomUUID(), title: change.headline, type: "新闻片", duration: change.duration, status: "待播", presenter: "值班主播", source: `插播：${change.reason}` });
      state.changes.unshift(change);
      if (!state.online) state.queue.unshift({ id: crypto.randomUUID(), action: "突发插播", detail: change.headline, queuedAt: change.createdAt });
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      if (!state.online) state.queue.unshift({ id: crypto.randomUUID(), action: "取消条目", detail: item.title, queuedAt: new Date().toISOString() });
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(last.snapshot);
    },
    queueChange(state, action: PayloadAction<{ action: string; detail: string }>) {
      state.queue.unshift({ ...action.payload, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
    },
    syncQueue(state) { state.queue = []; },

    /* ---------- 对外节目单：发布 / 作废 / 重发 ---------- */

    publishSchedule(state, action: PayloadAction<{ reason: string }>) {
      if (!denyUnlessEditor(state, "对外发布节目单")) return;
      const entries = buildEntries(state.items);
      const hash = hashEntries(entries);
      const current = latestPublish(state);
      if (current && current.hash === hash) {
        logEvent(state, "发布", "串联单内容与最新版本一致，无需重发");
        return;
      }
      const now = new Date().toISOString();
      const version = (current?.version ?? 0) + 1;
      // 串联单有改动：老版本里还没确认的在途/失败发送一律作废，按新版本重发
      for (const old of state.publishes) {
        for (const send of old.sends) {
          if (send.status === "在途" || send.status === "发布失败") {
            send.status = "已作废";
            logEvent(state, "作废", `v${old.version} 未确认，随新版本 v${version} 发布而作废`, send.channelId);
          }
        }
      }
      const sends: ChannelSend[] = CHANNELS.map(({ id }) => state.online
        ? { channelId: id, status: "在途", sentAt: now, attempts: 1 }
        : { channelId: id, status: "发布失败", sentAt: now, attempts: 1, failReason: "链路离线，待处理项已留住" });
      state.publishes.push({ version, publishedAt: now, reason: action.payload.reason || "串联单改动后对账重发", entries, hash, sends });
      logEvent(state, "发布", `主编发布节目单 v${version}，已向三个渠道下发` + (state.online ? "" : "（离线：发送失败，待重试）"));
    },

    /** 渠道按版本号回执；晚到的回执不能顶掉已确认的新版本，作废版本回执一律拒收 */
    receiveReceipt(state, action: PayloadAction<{ channelId: ChannelId; version: number }>) {
      const { channelId, version } = action.payload;
      const publish = state.publishes.find((candidate) => candidate.version === version);
      const send = publish?.sends.find((candidate) => candidate.channelId === channelId);
      const confirmed = confirmedVersion(state, channelId);
      if (!send) {
        logEvent(state, "回执", `收到 ${channelIdLabel(channelId)} 对 v${version} 的回执：版本不存在，拒收`, channelId);
        return;
      }
      if (confirmed !== null && version < confirmed) {
        logEvent(state, "回执", `${channelIdLabel(channelId)} 的 v${version} 回执晚到（当前已确认 v${confirmed}），拒绝顶换`, channelId);
        return;
      }
      if (send.status === "已作废") {
        logEvent(state, "回执", `${channelIdLabel(channelId)} 的 v${version} 已作废，回执拒收`, channelId);
        return;
      }
      if (send.status === "已确认") {
        logEvent(state, "回执", `${channelIdLabel(channelId)} v${version} 回执重复，忽略`, channelId);
        return;
      }
      send.status = "已确认";
      send.confirmedAt = new Date().toISOString();
      send.failReason = undefined;
      const channel = state.channels.find((candidate) => candidate.id === channelId);
      if (channel && (channel.version === null || version > channel.version)) channel.version = version;
      logEvent(state, "回执", `${channelIdLabel(channelId)} 已确认 v${version}`, channelId);
    },

    /** 模拟渠道网关发布失败：待处理项留住 */
    failSend(state, action: PayloadAction<{ channelId: ChannelId; version: number }>) {
      const send = state.publishes.find((p) => p.version === action.payload.version)?.sends.find((candidate) => candidate.channelId === action.payload.channelId);
      if (!send || send.status === "已确认" || send.status === "已作废") return;
      send.status = "发布失败";
      send.failReason = "渠道网关超时（模拟）";
      send.attempts += 1;
      logEvent(state, "失败", `v${action.payload.version} 下发${channelIdLabel(action.payload.channelId)}失败，待处理项已留住`, action.payload.channelId);
    },

    /** 发布失败后重试（属对外发布，仅主编） */
    retrySend(state, action: PayloadAction<{ channelId: ChannelId; version: number }>) {
      if (!denyUnlessEditor(state, "重试发布")) return;
      const { channelId, version } = action.payload;
      const send = state.publishes.find((p) => p.version === version)?.sends.find((candidate) => candidate.channelId === channelId);
      if (!send || send.status !== "发布失败") return;
      send.attempts += 1;
      if (!state.online) {
        send.failReason = "链路仍离线，继续留住待处理";
        logEvent(state, "失败", `v${version} 重试${channelIdLabel(channelId)}时链路离线，待处理项保留`, channelId);
        return;
      }
      send.status = "在途";
      send.failReason = undefined;
      logEvent(state, "重发", `v${version} 重新下发${channelIdLabel(channelId)}（第 ${send.attempts} 次尝试）`, channelId);
    },

    /** 渠道侧自行改动（模拟渠道行为，不受台内岗位限制）；新版本下发不覆盖它 */
    channelEditEntry(state, action: PayloadAction<{ channelId: ChannelId; override: Omit<ChannelOverride, "updatedAt"> }>) {
      const channel = state.channels.find((candidate) => candidate.id === action.payload.channelId);
      if (!channel) return;
      const override: ChannelOverride = { ...action.payload.override, updatedAt: new Date().toISOString() };
      const index = channel.overrides.findIndex((candidate) => candidate.itemId === override.itemId);
      if (index >= 0) channel.overrides[index] = override;
      else channel.overrides.push(override);
      logEvent(state, "渠道改动", `${channel.name}自行修改条目：${override.title}`, channel.id);
    },

    channelRevertOwnEdit(state, action: PayloadAction<{ channelId: ChannelId; itemId: string }>) {
      const channel = state.channels.find((candidate) => candidate.id === action.payload.channelId);
      if (!channel) return;
      channel.overrides = channel.overrides.filter((candidate) => candidate.itemId !== action.payload.itemId);
      logEvent(state, "清除改动", `${channel.name}撤回了一处自改`, channel.id);
    },

    /** 主编强制替换渠道自改（单项或整单），让渠道与台里发布版本一致 */
    forceReplace(state, action: PayloadAction<{ channelId: ChannelId; itemId?: string }>) {
      if (!denyUnlessEditor(state, "强制替换渠道节目单")) return;
      const channel = state.channels.find((candidate) => candidate.id === action.payload.channelId);
      if (!channel) return;
      const before = channel.overrides.length;
      channel.overrides = action.payload.itemId
        ? channel.overrides.filter((candidate) => candidate.itemId !== action.payload.itemId)
        : [];
      const removed = before - channel.overrides.length;
      if (removed === 0) return;
      logEvent(state, "强制替换", `主编将${channel.name}的 ${removed} 处渠道自改替换为台里版本（v${channel.version ?? "-"}）`, channel.id);
    }
  }
});

function channelIdLabel(id: ChannelId): string {
  return CHANNELS.find((channel) => channel.id === id)?.name ?? id;
}

export const {
  initialize, setRole, setOnline, addItem, adjustDuration, insertBreaking, reorder, skipItem, undo,
  updateStatus, queueChange, syncQueue, publishSchedule, receiveReceipt, failSend, retrySend,
  channelEditEntry, channelRevertOwnEdit, forceReplace
} = slice.actions;
export default slice.reducer;
