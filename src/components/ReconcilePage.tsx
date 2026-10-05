import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Col, Empty, Input, InputNumber, List, Row, Select, Switch, Tag, Timeline, Tooltip, message } from "antd";
import { format } from "date-fns";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { ackVersion, addLocalEdit, clearReject, publish, removeLocalEdit, retryPending, toggleSubscribe, voidInFlight, type ChannelId } from "../store/scheduleSlice";
import { isPinned, scheduledMap } from "../lib/schedule";
import type { RundownItem } from "../types";

const FIELD_LABELS: Record<string, string> = { title: "标题", duration: "时长", presenter: "主播", source: "来源" };

function statusColor(status: string) {
  if (status === "已发布") return "green";
  if (status === "发布失败") return "red";
  return "default";
}

/** 渠道在已确认版本基础上叠加本地改动后的生效节目单。 */
function effectiveItems(base: RundownItem[], edits: { itemId: string; field: string; localValue: string }[]): RundownItem[] {
  return base.map((item) => {
    const merged: Record<string, unknown> = { ...item };
    for (const e of edits) if (e.itemId === item.id) merged[e.field] = e.field === "duration" ? Number(e.localValue) || item.duration : e.localValue;
    return merged as unknown as RundownItem;
  });
}

function ChannelCard({ channelId }: { channelId: ChannelId }) {
  const dispatch = useAppDispatch();
  const channel = useAppSelector((s) => s.schedule.channels.find((c) => c.id === channelId)!);
  const versions = useAppSelector((s) => s.schedule.versions);
  const [lateVersion, setLateVersion] = useState<number>(1);
  const [editItem, setEditItem] = useState<string>("");
  const [editField, setEditField] = useState<string>("title");
  const [editValue, setEditValue] = useState<string>("");
  const [editNote, setEditNote] = useState<string>("");

  const baseItems = useMemo<RundownItem[]>(() => {
    const v = versions.find((x) => x.version === (channel.confirmedVersion ?? channel.inFlightVersion ?? versions[versions.length - 1]?.version));
    return v?.items ?? [];
  }, [versions, channel.confirmedVersion, channel.inFlightVersion]);

  const diffs = channel.localEdits.map((e) => ({ ...e, itemTitle: baseItems.find((i) => i.id === e.itemId)?.title ?? "已下线条目" }));
  const effective = effectiveItems(baseItems, channel.localEdits);

  return (
    <Card
      className="channel-card"
      title={<div className="channel-title"><span>{channel.name}</span><Switch size="small" checked={channel.subscribed} onChange={() => dispatch(toggleSubscribe(channel.id))} /></div>}
    >
      <div className="channel-versions">
        <span>已确认 <Tag color={channel.confirmedVersion != null ? "green" : "default"}>{channel.confirmedVersion != null ? `v${channel.confirmedVersion}` : "无"}</Tag></span>
        <span>在途 <Tag color={channel.inFlightVersion != null ? "blue" : "default"}>{channel.inFlightVersion != null ? `v${channel.inFlightVersion}` : "无"}</Tag></span>
      </div>

      {channel.inFlightVersion != null && (
        <div className="channel-actions">
          <Button size="small" type="primary" onClick={() => dispatch(ackVersion({ channelId: channel.id, version: channel.inFlightVersion! }))}>回执 v{channel.inFlightVersion}</Button>
          <Button size="small" onClick={() => dispatch(voidInFlight(channel.id))}>作废在途</Button>
        </div>
      )}

      <div className="late-ack">
        <InputNumber size="small" min={1} max={99} value={lateVersion} onChange={(v) => setLateVersion(Number(v ?? 1))} addonBefore="回执版本" />
        <Tooltip title="模拟渠道对一个旧版本号回执，验证晚到回执不会顶掉已确认版本">
          <Button size="small" onClick={() => dispatch(ackVersion({ channelId: channel.id, version: lateVersion }))}>模拟晚到回执</Button>
        </Tooltip>
      </div>

      {!!channel.pendingRetries.length && (
        <div className="pending-box">
          <small>发布失败 · 待重试</small>
          {channel.pendingRetries.map((p) => (
            <div key={p.id} className="pending-row">
              <Tag color="red">v{p.version}</Tag><span>{p.error}</span>
              <Button size="small" type="primary" ghost onClick={() => dispatch(retryPending({ channelId: channel.id, pendingId: p.id }))}>重试</Button>
            </div>
          ))}
        </div>
      )}

      <details className="channel-effective">
        <summary>渠道生效节目单（{effective.length} 条）</summary>
        <List size="small" dataSource={effective} renderItem={(item) => <List.Item><span>{item.title}</span><Tag>{item.type}</Tag></List.Item>} />
      </details>

      <div className="local-edits">
        <small>渠道本地改动（保留不覆盖）</small>
        {diffs.length ? diffs.map((d) => (
          <div key={d.id} className="diff-row">
            <Tag color="orange">{d.itemTitle}</Tag>
            <span className="diff-field">{FIELD_LABELS[d.field] ?? d.field}</span>
            <span className="diff-hq">{d.hqValue || "—"}</span><span>→</span><span className="diff-local">{d.localValue}</span>
            {d.note ? <small>{d.note}</small> : null}
            <Button size="small" type="text" danger onClick={() => dispatch(removeLocalEdit({ channelId: channel.id, editId: d.id }))}>删除</Button>
          </div>
        )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无本地改动" />}
        <div className="edit-form">
          <Select size="small" style={{ width: 130 }} value={editItem} onChange={setEditItem} options={baseItems.map((i) => ({ value: i.id, label: i.title }))} placeholder="选择条目" />
          <Select size="small" style={{ width: 90 }} value={editField} onChange={setEditField} options={Object.entries(FIELD_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
          <Input size="small" style={{ width: 110 }} value={editValue} onChange={(e) => setEditValue(e.target.value)} placeholder="本地值" />
          <Input size="small" style={{ width: 120 }} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="备注" />
          <Button size="small" disabled={!editItem || !editValue} onClick={() => {
            dispatch(addLocalEdit({ channelId: channel.id, itemId: editItem, field: editField, localValue: editValue, note: editNote }));
            setEditValue(""); setEditNote("");
          }}>标记改动</Button>
        </div>
      </div>

      <details className="ack-log">
        <summary>回执记录（{channel.acks.length}）</summary>
        <Timeline items={channel.acks.map((a) => ({ color: a.accepted ? "green" : "red", children: <div><Tag color={a.accepted ? "green" : "red"}>v{a.version} {a.accepted ? "已确认" : "已拒绝"}</Tag><small>{format(new Date(a.at), "HH:mm:ss")}</small>{a.reason ? <p>{a.reason}</p> : null}</div> }))} />
      </details>
    </Card>
  );
}

export function ReconcilePage() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.rundown.items);
  const role = useAppSelector((s) => s.rundown.role);
  const { versions, channels, lastReject } = useAppSelector((s) => s.schedule);
  const timeline = useMemo(() => scheduledMap(items), [items]);
  const pinned = items.filter(isPinned);

  useEffect(() => {
    if (lastReject) message.error(lastReject);
  }, [lastReject]);

  return (
    <div className="reconcile-page">
      <Alert
        className="reconcile-banner"
        type="info"
        showIcon
        message="节目单与串联单对账"
        description="串联单有改动时，尚未确认的在途版本作废并按新版本重发；有线网、手机端、卫星按版本号回执，晚到的回执不能顶掉已确认版本；渠道本地改动单独保留、不覆盖；整点新闻与签约广告时段锁定不挪。"
      />

      {lastReject && <Alert className="reconcile-reject" type="error" showIcon closable onClose={() => dispatch(clearReject())} message={lastReject} />}

      <Row gutter={16}>
        <Col span={16}>
          <Card
            title="节目单版本台账"
            extra={<Button type="primary" disabled={!items.length} onClick={() => dispatch(publish({ items, role }))}>对外发布新版本</Button>}
          >
            <List
              dataSource={[...versions].reverse()}
              locale={{ emptyText: "尚未发布节目单" }}
              renderItem={(v) => (
                <List.Item>
                  <List.Item.Meta
                    avatar={<Tag color={statusColor(v.status)}>{v.status}</Tag>}
                    title={<span>v{v.version} · {v.note}</span>}
                    description={<span>{format(new Date(v.publishedAt), "yyyy-MM-dd HH:mm")} · {v.publishedBy} 发布 · {v.items.length} 条</span>}
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="发布校验">
            <p>当前岗位：<Tag color={role === "主编" ? "green" : "default"}>{role}</Tag>{role !== "主编" && <small className="danger-text">（仅主编可对外发布/替换）</small>}</p>
            <p>锁定时段（整点新闻 / 签约广告）：</p>
            {pinned.length ? <List size="small" dataSource={pinned} renderItem={(it) => <List.Item><span>{it.title}</span><Tag color="gold">{timeline.get(it.id)} 播出</Tag><small>约定 {it.hardStart}</small></List.Item>} /> : <small>无</small>}
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        {channels.map((ch) => <Col key={ch.id} span={8}><ChannelCard channelId={ch.id} /></Col>)}
      </Row>
    </div>
  );
}
