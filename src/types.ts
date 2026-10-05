export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  /** 硬开点（HH:mm）。整点新闻、签约广告等锁点不可挪动 */
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
}

export function isLockedSlot(item: RundownItem): boolean {
  return Boolean(item.hardStart);
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export interface PendingChange {
  id: string;
  action: string;
  detail: string;
  queuedAt: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}

/* ---------- 对外节目单（EPG）对账 ---------- */

export type ChannelId = "cable" | "mobile" | "satellite";

/** 渠道收到的一条节目单节目 */
export interface ScheduleEntry {
  id: string;
  itemId: string;
  title: string;
  type: ItemType;
  start: string;
  duration: number;
  locked: boolean;
}

/** 渠道侧自行改动的覆盖项（只改文案/时长，锁点保留） */
export interface ChannelOverride {
  itemId: string;
  title: string;
  duration: number;
  note?: string;
  updatedAt: string;
}

/** 台里下发版本与渠道本地版本的差异 */
export interface ScheduleDiff {
  itemId: string;
  entryId: string;
  stationTitle: string;
  channelTitle: string;
  status: "保留差异" | "条目缺失";
}

export type SendStatus = "在途" | "已确认" | "发布失败" | "已作废";

/** 一次发布在某个渠道的下发记录 */
export interface ChannelSend {
  channelId: ChannelId;
  status: SendStatus;
  sentAt: string;
  confirmedAt?: string;
  failReason?: string;
  attempts: number;
}

export interface Publish {
  /** 发布时间即版本标识的来源；版本号递增 */
  version: number;
  publishedAt: string;
  reason: string;
  entries: ScheduleEntry[];
  hash: string;
  /** 旧数据没有版本号，升级后按发布时间回填初始版本 */
  backfilled?: boolean;
  sends: ChannelSend[];
}

export type ChannelEventKind =
  | "发布"
  | "重发"
  | "作废"
  | "回执"
  | "失败"
  | "渠道改动"
  | "清除改动"
  | "强制替换"
  | "越权拒绝"
  | "版本回填"
  | "锁点拦截";

export interface ChannelEvent {
  id: string;
  at: string;
  kind: ChannelEventKind;
  channelId?: ChannelId;
  detail: string;
}

export interface ChannelState {
  id: ChannelId;
  name: string;
  /** 当前对外挂着的版本号 */
  version: number | null;
  overrides: ChannelOverride[];
}
