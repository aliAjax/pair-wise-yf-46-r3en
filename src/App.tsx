import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { PublishPage } from "./components/PublishPage";
import { PERSIST_VERSION, useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addItem, adjustDuration, initialize, insertBreaking, publishSchedule, queueChange, reorder, setOnline, setRole, skipItem, syncQueue, undo, updateStatus } from "./store/rundownSlice";
import { buildEntries, scheduleConflicts } from "./store/reconcile";
import { isLockedSlot, type ItemType, type Role, type RundownItem } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function useTimeline(items: RundownItem[]) {
  // 锁点钉在 hardStart，重算时整点新闻/签约广告时段不挪
  const entries = useMemo(() => buildEntries(items), [items]);
  const starts = new Map(entries.map((entry) => [entry.itemId, entry.start]));
  const conflicts = new Set(scheduleConflicts(entries).map((entry) => entry.itemId));
  return { starts, conflicts };
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { items, role, online } = useAppSelector((state) => state.rundown);
  const saveMutation = useSaveRundownMutation()[0];
  const { publishes, channels } = useAppSelector((state) => state.rundown);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const { starts, conflicts } = useTimeline(items);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const lastStart = [...starts.values()].sort().at(-1) ?? "--:--";
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  useEffect(() => {
    const timer = setTimeout(() => {
      void saveMutation({ version: PERSIST_VERSION, items, publishes, channels });
    }, 250);
    return () => clearTimeout(timer);
  }, [items, publishes, channels, saveMutation]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || role !== "导播") return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    const moved = arrayMove(items, oldIndex, newIndex);
    // 整点新闻、签约广告等锁点时段不挪（reducer 也会兜底拦截并记审计）
    const locked = moved.filter((item, index) => isLockedSlot(item) && index !== items.findIndex((original) => original.id === item.id));
    if (locked.length) {
      message.error(`锁点时段不可挪动：${locked.map((item) => item.title).join("、")}`);
      return;
    }
    dispatch(reorder(moved));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    if (!online) dispatch(queueChange({ action: "新增条目", detail: values.title }));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button><Button type="primary" onClick={() => navigate("/publish")}>对外发布 / 对账</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={conflicts.size ? "danger-text" : ""}><b>{conflicts.size}</b> 个硬时间风险</span><span><b>{lastStart}</b> 最后条目开点</span></div>
      {conflicts.size > 0 && <p className="danger-text conflict-note">⚠ 非锁点内容与整点新闻/签约广告窗口重叠；锁点保持不动，请压缩前置内容或处理插播。</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{items.map((item) => <SortableItem key={item.id} item={item} cumulative={starts.get(item.id) ?? "--:--"} conflict={conflicts.has(item.id)} onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} />)}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={role === "字幕"}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online, role } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2} onClick={() => {
      dispatch(insertBreaking(values));
      if (!online) message.warning("已进入本地应急队列");
      // 插播改动串联单后，主编一键发布：未确认的在途版本自动作废并按新版本重发
      dispatch(publishSchedule({ reason: `突发插播「${values.headline}」后对账重发` }));
      if (role !== "主编") message.error(`越权操作已拒绝：仅主编可对外发布，当前岗位「${role}」`);
      setValues({ ...values, headline: "" });
    }}>插入并重算（锁点不挪）</Button>
    <small>整点新闻、签约广告的硬开点固定不变；插播后对外节目单需由主编发布新版本对账。</small>
    {!online && <small>离线操作将在主链路恢复后统一提交，当前顺序仍可用于本地播出。</small>}
  </Card>;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  const dispatch = useAppDispatch();
  if (mode === "queue") return <Card title="本地应急队列"><div className="queue-list">{state.queue.length ? state.queue.map((item) => <article key={item.id}><Tag color="red">{item.action}</Tag><b>{item.detail}</b><small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small></article>) : <p>当前没有待同步操作。</p>}</div><Button type="primary" disabled={state.online} onClick={() => { dispatch(syncQueue()); message.success("应急队列已同步"); }}>主链路恢复后提交</Button></Card>;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useEffect(() => {
    if (!data) return;
    if (data.legacy) dispatch(initialize({ legacy: true, items: data.items }));
    else dispatch(initialize({ legacy: false, items: data.items, publishes: data.publishes, channels: data.channels }));
  }, [data, dispatch]);
  const inFlight = [...state.publishes].reduce(
    (sum, publish) => sum + publish.sends.filter((send) => send.status === "在途" || send.status === "发布失败").length,
    0
  );
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/publish">{t("publish")} {inFlight ? <em>{inFlight}</em> : null}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header><Routes><Route path="/" element={<RundownPage />} /><Route path="/publish" element={<PublishPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
  </div>;
}
