import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import type { RundownItem } from "../types";
import { isLockedSlot } from "../types";

export function SortableItem({ item, cumulative, conflict, onStatus, onSkip, onDuration }: { item: RundownItem; cumulative: string; conflict?: boolean; onStatus: () => void; onSkip: () => void; onDuration: (delta: number) => void }) {
  const locked = isLockedSlot(item);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: item.status === "已播出" || locked });
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} ${conflict ? "row-conflict" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <Tooltip title={locked ? "锁点时段（整点新闻/签约广告），不可挪动" : "拖拽调整"}><button className="drag-handle" {...(locked ? {} : attributes)} {...(locked ? {} : listeners)} style={locked ? { cursor: "not-allowed", color: "#c99" } : undefined}>{locked ? "🔒" : "⠿"}</button></Tooltip>
      <time>{cumulative}{item.hardStart && <small className="hard-tag">硬 {item.hardStart}</small>}</time>
      <div className="row-main"><b>{item.title}{locked && <Tag color="gold" style={{ marginInlineStart: 6 }}>锁点不挪</Tag>}</b><small>{item.source} · {item.presenter}</small></div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        <Button size="small" onClick={() => onDuration(-1)}>-1</Button>
        <Button size="small" onClick={() => onDuration(1)}>+1</Button>
        <Button size="small" type="primary" disabled={item.status === "已播出"} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={item.status === "已播出"} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
