import { useEffect, useRef, useState } from "react";
import { ArrowDownUp, ArrowRight, Check, ChevronDown, ChevronLeft, Copy, FileText, Folder, Info, Link2, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { DemoAction } from "@/components/demo-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { accountVariant, variantLabel } from "@/lib/variant";
import type { SessionGroupClient, SessionGroupDetail, SessionGroupMemberDetail, SessionGroupPairPreview } from "@/lib/types";
import "./session-group-detail.css";

export interface GroupDetailPanelProps {
  client: SessionGroupClient;
  detail: SessionGroupDetail | null;
  sourceMemberId: string;
  setSourceMemberId: (id: string) => void;
  addTargetId: string;
  setAddTargetId: (id: string) => void;
  previews: Record<string, SessionGroupPairPreview>;
  pendingMember: string | null;
  busy: boolean;
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onRetry: () => void;
  onPreview: (member: SessionGroupMemberDetail) => void;
  // Both handlers resolve when the page finished its toast/reload work, so the panel can
  // close the popover only after the operation (success or failure) is done.
  onSync: (member: SessionGroupMemberDetail, mode: "fastForward" | "overwrite") => Promise<void>;
  onBatchSync: () => void;
  onAdd: () => Promise<void>;
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
  fullPage: boolean;
}

const clientNames: Record<SessionGroupClient, string> = {
  workbuddy: "WorkBuddy", codebuddyIde: "CodeBuddy IDE", vscodeExt: "CodeBuddy 插件",
};

export function GroupDetailPanel(props: GroupDetailPanelProps) {
  const { detail } = props;
  const panelRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const [operationTarget, setOperationTarget] = useState("");
  const graphRef = useRef<HTMLDivElement>(null);
  const [connections, setConnections] = useState<{ path: string; x: number; y: number; hx: number; hy: number }[]>([]);
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    function measure() {
      if (!graph) return;
      const base = graph.getBoundingClientRect();
      const hub = graph.querySelector<HTMLElement>("[data-session-hub]")?.getBoundingClientRect();
      if (!hub) return;
      const nodes = [...graph.querySelectorAll<HTMLElement>("[data-session-member]")];
      const next = nodes.map((node, index) => {
        const box = node.getBoundingClientRect();
        const left = index < Math.ceil(nodes.length / 2);
        const x = (left ? box.right : box.left) - base.left;
        const y = box.top + box.height / 2 - base.top;
        const hx = (left ? hub.left : hub.right) - base.left;
        const rows = Math.ceil(nodes.length / 2);
        const hy = hub.top - base.top + hub.height * (((index % rows) + 1) / (rows + 1));
        const mid = (x + hx) / 2;
        const dx = Math.sign(hx - x);
        const dy = Math.sign(hy - y);
        const radius = Math.min(12, Math.abs(hy - y) / 2, Math.abs(hx - x) / 4);
        const path = radius < 1 ? `M ${x} ${y} H ${hx}`
          : `M ${x} ${y} H ${mid - dx * radius} Q ${mid} ${y} ${mid} ${y + dy * radius} V ${hy - dy * radius} Q ${mid} ${hy} ${mid + dx * radius} ${hy} H ${hx}`;
        return { path, x, y, hx, hy };
      });
      setConnections(next);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(graph);
    graph.querySelectorAll<HTMLElement>("[data-session-member], [data-session-hub]").forEach((node) => observer.observe(node));
    measure();
    return () => observer.disconnect();
  }, [detail, wide]);
  useEffect(() => {
    if (!panelRef.current) return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 760));
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

  const active = detail?.members.filter((member) => member.linkState === "active") ?? [];
  const equal = detail?.summaryStatus === "latest" && active.length > 0;
  const sourceOptions = active.filter((member) => member.canBeSource);
  const selectedSource = sourceOptions.find((member) => member.memberId === props.sourceMemberId);
  // Batch sync chooses its own verified source on the backend, independently of the copy form.
  const batchSource = active.find((member) => member.memberId === detail?.safeSourceMemberId);
  const behind = active.filter((member) => member.versionStatus === "behind");
  const canBatch = !!batchSource && behind.length > 0;
  const summary = equal
    ? `${active.length} 个账号内容一致`
    : canBatch ? `${behind.length} 个账号有待同步内容`
    : detail?.summaryStatus === "diverge" ? "账号内容存在分歧"
    : detail?.summaryStatus === "missing" ? "部分账号内容缺失" : "部分内容状态尚无法确认";

  function openOperation(member: SessionGroupMemberDetail) {
    props.setAddOpen(false);
    setOperationTarget(member.memberId);
    props.setSourceMemberId(batchSource?.memberId ?? sourceOptions.find((item) => item.memberId !== member.memberId)?.memberId ?? "");
  }
  // A stored preview is only valid for the exact source/target/group/client it was requested for.
  function memberPreview(member: SessionGroupMemberDetail): SessionGroupPairPreview | undefined {
    const preview = props.previews[member.memberId];
    return preview && preview.sourceMemberId === props.sourceMemberId
      && preview.targetMemberId === member.memberId
      && preview.groupId === detail?.groupId
      && preview.client === props.client ? preview : undefined;
  }
  // Close the popover after the page handler settled; it resolves on failure too and keeps the toast.
  async function completeAdd() {
    await props.onAdd();
    props.setAddOpen(false);
  }
  async function completeSync(member: SessionGroupMemberDetail, mode: "fastForward" | "overwrite") {
    await props.onSync(member, mode);
    setOperationTarget("");
  }
  function openAdd() {
    setOperationTarget("");
    props.setAddOpen(true);
  }
  function sourceSelect(label: string) {
    return <Select value={selectedSource?.memberId ?? ""} onValueChange={props.setSourceMemberId} disabled={props.busy || sourceOptions.length === 0}>
      <SelectTrigger className="w-full min-w-0 bg-background" aria-label={label}><SelectValue placeholder="选择可读取的账号副本" /></SelectTrigger>
      <SelectContent>{sourceOptions.map((member) => <SelectItem key={member.memberId} value={member.memberId}>{member.accountName} · {variantLabel(member.variant)}</SelectItem>)}</SelectContent>
    </Select>;
  }

  return <section ref={panelRef} aria-label="会话组详情" data-relationship-layout={wide ? "hub-wide" : "hub-compact"} className="session-relationship flex h-full min-h-0 min-w-0 flex-col bg-card">
    <div className="flex shrink-0 items-center justify-between px-5 py-4">
      <span className="text-sm font-medium text-muted-foreground">会话详情</span>
      <Button variant="ghost" size={props.fullPage ? "sm" : "icon"} aria-label={props.fullPage ? "返回会话" : "关闭详情"} onClick={props.onClose}>
        {props.fullPage ? <><ChevronLeft />返回会话</> : <X />}
      </Button>
    </div>
    <div data-detail-scroll className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
      {props.error && <div role="alert" className="mb-4 space-y-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
        <p className="break-words">{props.error}</p><Button variant="outline" size="sm" disabled={props.loading} onClick={props.onRetry}>重试</Button>
      </div>}
      {!detail && !props.error && <div aria-label="正在加载会话详情" aria-busy="true" className="space-y-4">
        <Skeleton className="h-8 w-3/4" /><Skeleton className="h-20 w-full" /><Skeleton className="h-56 w-full" />
      </div>}
      {detail && <>
        <h2 className={`break-words font-semibold leading-snug tracking-tight ${wide ? "text-3xl" : "text-2xl"}`}>{detail.title}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant="success">{clientNames[props.client]}</Badge>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><Folder className="size-3.5 shrink-0" /><span className="truncate" title={detail.projectLabel}>{detail.projectLabel || "未标记项目"}</span></span>
        </div>
        <div className={`my-5 flex items-center gap-3 rounded-lg p-3 ${equal ? "bg-brand/10" : "bg-muted/70"}`} data-relationship-summary>
          <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${equal ? "bg-brand text-brand-foreground" : "bg-background text-muted-foreground"}`}>{equal ? <Check className="size-4" /> : <Info className="size-4" />}</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-1"><p className="text-base font-semibold">{summary}</p>{equal && active[0]?.recordCount != null && <p className="text-sm text-muted-foreground">{active[0].recordCount} 条内容 · 无需同步</p>}</div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="重新检查会话状态" title="重新检查" disabled={props.loading || props.busy} onClick={props.onRetry}><RefreshCw className={props.loading ? "animate-spin" : undefined} /></Button>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div><h3 className="text-base font-semibold">会话关联图</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">同一会话，在不同账号中各有一份</p></div>
          <span className="rounded-full bg-muted px-2 py-1 text-xs tabular-nums text-muted-foreground">{detail.members.length} 个账号</span>
        </div>
        <div className="relationship-canvas rounded-xl border border-brand/10 bg-brand/5 p-4">
          <div ref={graphRef} className="relationship-graph">
          <svg className="relationship-connections" aria-hidden="true">{connections.map((line, index) => <g key={index}><path d={line.path} /><circle cx={line.x} cy={line.y} r="3.5" /><circle cx={line.hx} cy={line.hy} r="3.5" /></g>)}</svg>
          <div className="relationship-root" data-session-hub>
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-brand/25 bg-brand/10 text-brand"><FileText className="size-6" /></span>
            <div><p className="text-base font-semibold">同一会话</p><p className="mt-0.5 text-xs text-muted-foreground">{detail.members.length} 个关联账号</p></div>{equal && <Badge variant="success">内容一致</Badge>}
          </div>
          <ul className="relationship-members" aria-label="关联账号副本">
            {detail.members.map((member, index) => {
              const isActive = member.linkState === "active";
              const canInspect = isActive && !equal && member.memberId !== batchSource?.memberId;
              // Any active member can become the operation target after 交换来源与目标, so every
              // active card hosts a popover; a card without the entry button only needs an
              // invisible anchor for that swapped state.
              const canHostOperation = isActive && !equal;
              const status = member.linkState === "active" ? member.versionStatus : member.linkState;
              const preview = memberPreview(member);
              const conflictTitle = detail.summaryStatus === "diverge" ? "处理分歧" : "检查副本差异";
              return <li key={member.memberId} className="relationship-branch" style={{ gridColumn: index < Math.ceil(detail.members.length / 2) ? 1 : 3, gridRow: index % Math.ceil(detail.members.length / 2) + 1 }} data-session-member={member.memberId} data-link-state={member.linkState}>
                <Popover open={operationTarget === member.memberId} onOpenChange={(open) => { if (!open) setOperationTarget(""); }}>
                  <article className={`relative min-w-0 rounded-lg border bg-card p-3.5 shadow-xs ${isActive ? "border-border" : "border-dashed border-border text-muted-foreground"}`}>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h4 className="min-w-0 break-words text-base font-semibold [overflow-wrap:anywhere]">{member.accountName}</h4>
                      <Badge variant="secondary" className="shrink-0 text-[11px]">{variantLabel(member.variant)}</Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2"><span className="text-[13px] tabular-nums text-muted-foreground">{member.recordCount == null ? "内容条数无法确认" : `${member.recordCount} 条内容`}</span><MemberStatus status={status} equal={equal} /></div>
                    <Collapsible className="mt-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-2"><p className="text-[13px] text-muted-foreground">{formatDate(member.updatedAt)}</p><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-6 gap-1 px-0 text-[13px] text-brand">副本详情<ChevronDown className="size-3" /></Button></CollapsibleTrigger></div>
                      <CollapsibleContent className="space-y-1 py-2 text-xs leading-5 text-muted-foreground"><p className="break-words">{member.projectLabel || "未标记工作区"}</p><p className="break-words">{member.reason}</p></CollapsibleContent>
                    </Collapsible>
                    {isActive && member.versionStatus === "behind" && batchSource && <p className="mt-2 flex items-start gap-1 text-xs leading-5 text-muted-foreground"><ArrowRight className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">可从「{batchSource.accountName}」同步</span></p>}
                    {canInspect && <PopoverTrigger asChild><Button variant="outline" size="sm" className="mt-2 h-7 text-xs" disabled={props.busy} onClick={() => openOperation(member)}>{member.versionStatus === "diverge" ? "处理分歧" : "检查差异"}</Button></PopoverTrigger>}
                    {canHostOperation && !canInspect && <PopoverAnchor asChild><span aria-hidden className="block h-0 w-full" /></PopoverAnchor>}
                  </article>
                  {canHostOperation && <PopoverContent data-conflict-flow side="top" collisionPadding={12} aria-label={conflictTitle} className="w-[min(360px,calc(100vw-32px))] space-y-3">
                    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{conflictTitle}</h3><Button variant="ghost" size="sm" onClick={() => setOperationTarget("")}>取消</Button></div>
                    <p className="text-xs text-muted-foreground">仅选择本次操作的来源和目标。检查不会修改任何副本。</p>
                    <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><p className="text-xs">来源账号</p>{sourceSelect("选择比较来源")}</div><div className="space-y-1"><p className="text-xs">目标账号</p><Select value={operationTarget} onValueChange={setOperationTarget} disabled={props.busy}><SelectTrigger className="w-full" aria-label="选择比较目标"><SelectValue /></SelectTrigger><SelectContent>{active.filter((item) => item.memberId !== props.sourceMemberId).map((item) => <SelectItem key={item.memberId} value={item.memberId}>{item.accountName}</SelectItem>)}</SelectContent></Select></div></div>
                    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={props.busy || !member.canBeSource || !selectedSource || member.memberId === selectedSource.memberId} onClick={() => { const previous = props.sourceMemberId; props.setSourceMemberId(member.memberId); setOperationTarget(previous); }}><ArrowDownUp />交换来源与目标</Button><Button size="sm" disabled={props.busy || !selectedSource || member.memberId === selectedSource.memberId || !!props.pendingMember} onClick={() => props.onPreview(member)}>{props.pendingMember ? <Loader2 className="animate-spin" /> : <RefreshCw />}检查差异</Button></div>
                    {preview && <div className="space-y-2"><p className="text-sm">{preview.reason}</p>{preview.availableModes.includes("overwrite") && <p className="text-sm text-destructive">目标独有 {preview.extraTargetCount} 条内容将被替换，无法通过本工具撤销。</p>}<div className="flex gap-2">{preview.previewToken && preview.availableModes.includes("fastForward") && <DemoAction><Button disabled={props.busy} onClick={() => void completeSync(member, "fastForward")}>同步到目标</Button></DemoAction>}{preview.previewToken && preview.availableModes.includes("overwrite") && <DemoAction><Button variant="destructive" disabled={props.busy} onClick={() => void completeSync(member, "overwrite")}>覆盖目标</Button></DemoAction>}</div></div>}
                    <PopoverArrow />
                  </PopoverContent>}
                </Popover>
              </li>;
            })}
          </ul>
          </div>
          {equal && <p className="mt-4 flex items-center justify-center gap-2 text-xs leading-5 text-muted-foreground"><Check className="size-4 shrink-0 text-brand" />有效关联内容一致，无需同步</p>}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{equal ? "账号更新后，可重新检查同步方向与内容差异。" : "连线表示账号关联；同步方向以内容检查结果为准。"}</p>
      </>}
    </div>
    {detail && <Popover open={props.addOpen} onOpenChange={(open) => { if (!open) props.setAddOpen(false); }}>
      <footer data-detail-footer className="relationship-footer shrink-0 space-y-2.5 border-t border-border/70 bg-card px-5 py-4">
        {canBatch ? <>
          <DemoAction className="w-full"><Button className="h-11 w-full bg-brand text-brand-foreground hover:bg-brand/90" disabled={props.busy} onClick={props.onBatchSync}><RefreshCw className={props.busy ? "animate-spin" : undefined} />同步 {behind.length} 个落后账号</Button></DemoAction>
          <div className="flex items-center justify-between gap-2"><p className="min-w-0 truncate text-xs text-muted-foreground" title={`${batchSource.accountName} → ${behind.map((member) => member.accountName).join("、")}`}>{batchSource.accountName} → {behind.length} 个账号</p><PopoverTrigger asChild><Button variant="ghost" size="sm" className="h-7 shrink-0 px-1 text-xs" onClick={openAdd}><Plus />关联新账号</Button></PopoverTrigger></div>
        </> : <>
          <PopoverTrigger asChild><Button className="h-11 w-full bg-brand text-brand-foreground hover:bg-brand/90" onClick={openAdd}><Link2 />关联新账号</Button></PopoverTrigger>
          <p className="text-center text-xs leading-5 text-muted-foreground">选择一个现有账号，将会话复制到新账号</p>
        </>}
      </footer>
      <PopoverContent side="top" collisionPadding={12} aria-label="关联新账号" className="w-[min(320px,calc(100vw-32px))] space-y-3">
        <h3 className="text-sm font-semibold">关联新账号</h3>
        <p className="text-xs leading-5 text-muted-foreground">{equal ? "选择任一可读取的副本，复制到新账号并建立关联。" : "将所选账号的当前副本复制到新账号，并建立关联。"}</p>
        <div className="space-y-1.5"><p className="text-xs font-medium">复制来源</p>{sourceSelect("选择复制来源")}</div>
        <div className="space-y-1.5"><p className="text-xs font-medium">目标账号</p><Select value={props.addTargetId} onValueChange={props.setAddTargetId} disabled={props.busy || detail.addTargets.length === 0}>
          <SelectTrigger className="w-full min-w-0 bg-background" aria-label="目标关联账号"><SelectValue placeholder="选择兼容账号" /></SelectTrigger>
          <SelectContent>{detail.addTargets.map((account) => <SelectItem key={account.id} value={account.id}>{account.nickname || account.email || account.uid || account.id} · {variantLabel(accountVariant(account))}</SelectItem>)}</SelectContent>
        </Select></div>
        {detail.addTargets.length === 0 && <p className="text-xs text-muted-foreground">没有可添加的兼容账号。</p>}
        <DemoAction className="w-full"><Button className="w-full" disabled={props.busy || !selectedSource || !props.addTargetId} onClick={() => void completeAdd()}><Copy />{props.busy ? "处理中…" : "复制并关联"}</Button></DemoAction>
        <PopoverArrow />
      </PopoverContent>
    </Popover>}
  </section>;
}

function MemberStatus({ status, equal }: { status: SessionGroupMemberDetail["versionStatus"]; equal: boolean }) {
  const labels: Record<typeof status, string> = {
    latest: equal ? "内容一致" : "较新内容", behind: "内容落后", diverge: "存在分歧",
    missing: "内容缺失", unknown: "无法确认", stale: "已失效", superseded: "已替代",
  };
  const variant = status === "latest" ? "success" : ["behind", "diverge", "missing"].includes(status) ? "warning" : "outline";
  return <Badge variant={variant} className="text-[11px] font-medium">{labels[status]}</Badge>;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "更新时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}
