import { useState } from "react";
import { Alert, Button, Card, Empty, InputNumber, Select, Table, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import {
  channelEditEntry,
  channelRevertOwnEdit,
  failSend,
  forceReplace,
  publishSchedule,
  receiveReceipt,
  retrySend
} from "../store/rundownSlice";
import { channelView, diffAgainstChannel } from "../store/reconcile";
import type { ChannelId, ChannelState, Publish, ScheduleEntry, SendStatus } from "../types";

const STATUS_COLOR: Record<SendStatus, string> = {
  在途: "processing",
  已确认: "success",
  发布失败: "error",
  已作废: "default"
};

function fmt(iso?: string): string {
  return iso ? format(new Date(iso), "HH:mm:ss") : "--:--:--";
}

export function PublishPage() {
  const dispatch = useAppDispatch();
  const { role, online, publishes, channels, epgLog } = useAppSelector((state) => state.rundown);
  const [reason, setReason] = useState("突发插播后重发对外节目单");
  const ordered = [...publishes].sort((a, b) => b.version - a.version);
  const latest = ordered[0];
  const isEditor = role === "主编";

  const guard = (action: () => void, label: string) => {
    action();
    if (!isEditor) message.error(`越权操作已拒绝：仅主编可${label}，当前岗位「${role}」`);
  };

  return <div className="publish-grid">
    <div className="publish-main">
      <Alert style={{ marginBottom: 14 }} type={online ? "success" : "warning"} showIcon
        message={online ? "主备链路正常：发布失败的待处理项可随时重试" : "本地应急模式：新发版本会先记为发布失败，待链路恢复后重试"} />
      <Card className="publish-bar" title={<span>对外发布 · 节目单跟随串联单对账 {!isEditor && <Tag color="red">当前岗位「{role}」无发布权</Tag>}</span>}
        extra={<Tag color="blue">最新待发内容指纹：{latest?.hash ?? "--"}</Tag>}>
        <div className="publish-action">
          <Select value={reason} onChange={setReason} style={{ flex: 1, minWidth: 240 }}
            options={["突发插播后重发对外节目单", "时长调整后对账重发", "主编主动刷新对外节目单"].map((value) => ({ value, label: value }))} />
          <Button type="primary" danger={!isEditor} onClick={() => guard(() => {
            dispatch(publishSchedule({ reason }));
            if (isEditor) message.success(online ? "新版本已下发，未确认的在途版本全部作废" : "新版本已生成：离线发送失败，待处理项已留住");
          }, "对外发布")}>发布到有线网 / 手机端 / 卫星</Button>
        </div>
        <small>规则：串联单改动后，未确认的在途版本立即作废并按新版本重发；内容无变化不重复发布。整点新闻与签约广告锁点不挪。</small>
      </Card>

      <Card title="版本与渠道回执" style={{ marginTop: 14 }}>
        <div className="version-list">
          {ordered.map((publish) => <VersionBlock key={publish.version} publish={publish} role={role} isEditor={isEditor} online={online} />)}
        </div>
      </Card>
    </div>

    <aside className="publish-side">
      {channels.map((channel) => <ChannelCard key={channel.id} channel={channel} latest={latest} isEditor={isEditor} />)}
      <Card title="对账审计" size="small" style={{ marginTop: 14 }}>
        <Timeline items={epgLog.slice(0, 30).map((event) => ({
          color: event.kind === "越权拒绝" || event.kind === "失败" || event.kind === "锁点拦截" ? "red"
            : event.kind === "回执" || event.kind === "强制替换" ? "green" : "blue",
          children: <div><Tag>{event.kind}</Tag><b>{event.detail}</b><small>{fmt(event.at)}</small></div>
        }))} />
      </Card>
    </aside>
  </div>;
}

function VersionBlock({ publish, role, isEditor, online }: { publish: Publish; role: string; isEditor: boolean; online: boolean }) {
  const dispatch = useAppDispatch();
  return <article className="version-block">
    <header>
      <div><b>v{publish.version}</b>{publish.backfilled && <Tag color="gold">旧数据回填</Tag>} <Tag>{format(new Date(publish.publishedAt), "MM-dd HH:mm:ss")}</Tag></div>
      <small>{publish.reason}</small>
    </header>
    <div className="send-rows">
      {publish.sends.map((send) => {
        const name = channelNameOf(send.channelId);
        return <div key={send.channelId} className="send-row">
          <b>{name}</b>
          <Tag color={STATUS_COLOR[send.status]}>{send.status}</Tag>
          <small>发送 {fmt(send.sentAt)}{send.confirmedAt ? ` · 确认 ${fmt(send.confirmedAt)}` : ""} · 第 {send.attempts} 次{send.failReason ? ` · ${send.failReason}` : ""}</small>
          <span className="send-btns">
            {(send.status === "在途" || send.status === "发布失败") && <Button size="small" onClick={() => { dispatch(receiveReceipt({ channelId: send.channelId, version: publish.version })); message.success(`已模拟${name}按版本号回执 v${publish.version}`); }}>模拟渠道回执</Button>}
            {send.status === "在途" && <Button size="small" danger onClick={() => dispatch(failSend({ channelId: send.channelId, version: publish.version }))}>模拟发送失败</Button>}
            {send.status === "发布失败" && <Button size="small" type="primary" danger={!isEditor} onClick={() => {
              dispatch(retrySend({ channelId: send.channelId, version: publish.version }));
              if (!isEditor) message.error(`越权操作已拒绝：仅主编可重试发布，当前岗位「${role}」`);
              else message.info(online ? "已重新下发，等待渠道按版本号回执" : "链路仍离线，待处理项继续留住");
            }}>重试发布</Button>}
          </span>
        </div>;
      })}
    </div>
  </article>;
}

function channelNameOf(id: ChannelId): string {
  return { cable: "有线网", mobile: "手机端", satellite: "卫星" }[id];
}

function ChannelCard({ channel, latest, isEditor }: { channel: ChannelState; latest?: Publish; isEditor: boolean }) {
  const dispatch = useAppDispatch();
  const { publishes } = useAppSelector((state) => state.rundown);
  const view = channelView(publishes, channel);
  const diffs = latest ? diffAgainstChannel(latest, channel) : [];
  const overridden = new Set(channel.overrides.map((entry) => entry.itemId));
  const [editItem, setEditItem] = useState<string>(latest?.entries[0]?.itemId ?? "");
  const [editTitle, setEditTitle] = useState("");
  const [editDuration, setEditDuration] = useState<number>(5);

  const guardDispatch = (label: string, fn: () => void) => {
    fn();
    if (!isEditor) message.error(`越权操作已拒绝：仅主编可${label}，当前岗位无权替换渠道内容`);
  };

  return <Card size="small" className="channel-card" title={<span>{channel.name} <Tag color="blue">对外挂着 v{channel.version ?? "-"}</Tag></span>}>
    {view.length === 0 ? <Empty description="尚无已确认版本" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : <>
      <Table<ScheduleEntry> size="small" pagination={false} rowKey="entryId" dataSource={view}
        columns={[
          { title: "开始", dataIndex: "start", width: 58 },
          { title: "节目", render: (_, record) => <span>{record.title}{record.locked && <Tag color="gold" style={{ marginLeft: 6 }}>锁点</Tag>}{overridden.has(record.itemId) && <Tag color="purple" style={{ marginLeft: 6 }}>渠道自改</Tag>}</span> },
          { title: "时长", dataIndex: "duration", width: 56, render: (value) => `${value}′` }
        ]} />
      {diffs.length > 0 && <div className="diff-box">
        <b>对账差异（渠道自改保留，不被新版本覆盖）</b>
        {diffs.map((diff) => <div key={diff.itemId} className="diff-row">
          <Tag color={diff.status === "保留差异" ? "purple" : "orange"}>{diff.status}</Tag>
          <span>台里：{diff.stationTitle} ⇄ 渠道：{diff.channelTitle}</span>
          <span className="send-btns">
            {diff.status === "保留差异" && <Button size="small" onClick={() => dispatch(channelRevertOwnEdit({ channelId: channel.id, itemId: diff.itemId }))}>渠道撤回自改</Button>}
            <Button size="small" type="primary" danger={!isEditor} onClick={() => guardDispatch("替换渠道内容", () => {
              dispatch(forceReplace({ channelId: channel.id, itemId: diff.itemId }));
              if (isEditor) message.success(`已将${channel.name}该条目强制替换为台里版本`);
            })}>主编强制替换</Button>
          </span>
        </div>)}
        <Button size="small" block danger={!isEditor} style={{ marginTop: 8 }} onClick={() => guardDispatch("整单替换渠道节目单", () => {
          dispatch(forceReplace({ channelId: channel.id }));
          if (isEditor) message.success(`已整单强制替换${channel.name}节目单`);
        })}>主编整单强制替换（{diffs.length} 处差异）</Button>
      </div>}
      <div className="channel-edit">
        <small>模拟渠道侧自行改动：</small>
        <Select size="small" value={editItem} onChange={setEditItem} style={{ width: "100%" }}
          options={(latest?.entries ?? []).map((entry) => ({ value: entry.itemId, label: entry.title }))} />
        <div className="two-cols">
          <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} placeholder="渠道改用的标题" />
          <InputNumber size="small" min={1} max={120} value={editDuration} onChange={(value) => setEditDuration(Number(value ?? 1))} addonAfter="分钟" />
        </div>
        <Button size="small" block disabled={!editItem || editTitle.trim().length < 2} onClick={() => {
          const source = latest?.entries.find((entry) => entry.itemId === editItem);
          if (!source) return;
          dispatch(channelEditEntry({ channelId: channel.id, override: { itemId: editItem, title: editTitle.trim(), duration: editDuration, note: "渠道自改" } }));
          setEditTitle("");
          message.info(`${channel.name}的自改已保留，台里再发新版本也不会覆盖，将单列差异`);
        }}>渠道自改该条目</Button>
      </div>
    </>}
  </Card>;
}
