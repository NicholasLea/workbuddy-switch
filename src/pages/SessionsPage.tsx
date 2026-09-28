import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, Copy, Folder, MessageCircle, Layers3, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { CodeBuddyCnIdeMark, VscodeExtMark, WorkBuddyAiMark, WorkBuddyMark } from "@/components/product-marks";
import { GroupDetailPanel } from "@/components/session-group-detail";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as api from "@/lib/api";
import type { SessionGroupClient, SessionGroupCurrentAccount, SessionGroupDetail, SessionGroupMemberDetail, SessionGroupSummary, SessionGroupUnifyPlan, SessionSyncMode, WbVariant } from "@/lib/types";
import { variantLabel } from "@/lib/variant";
import { useAccountsStore } from "@/stores/accounts";

const PAGE_SIZE = 8;
const CLIENTS: { id: SessionGroupClient; title: string; description: string }[] = [
  { id: "workbuddy", title: "WorkBuddy", description: "含国内版与国际版会话" },
  { id: "codebuddyIde", title: "CodeBuddy IDE", description: "国内版 / 国际版独立分组" },
  { id: "vscodeExt", title: "CodeBuddy 插件", description: "VS Code 扩展会话" },
];

export default function SessionsPage() {
  const { accounts, fetchAll } = useAccountsStore();
  const [client, setClient] = useState<SessionGroupClient>("workbuddy");
  const [variantScope, setVariantScope] = useState<WbVariant>("cn");
  const [groups, setGroups] = useState<SessionGroupSummary[]>([]);
  const [storeStatus, setStoreStatus] = useState<"missing" | "ready" | "unavailable">("missing");
  const [storeError, setStoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("recent");
  const [page, setPage] = useState(1);
  const [sourceMemberId, setSourceMemberId] = useState("");
  const [addTargetId, setAddTargetId] = useState("");
  const [unifyPlan, setUnifyPlan] = useState<SessionGroupUnifyPlan | null>(null);
  const [unifyLoading, setUnifyLoading] = useState<string | null>(null);
  const [currentAccounts, setCurrentAccounts] = useState<SessionGroupCurrentAccount[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [contentWidth, setContentWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const detailMode = "modal";
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => setContentWidth(entry.contentRect.width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  function closeDetail() {
    setDetailOpen(false);
    requestAnimationFrame(() => openerRef.current?.focus({ preventScroll: true }));
  }
  function openDetail(id: string, copy = false) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedGroupId(id);
    setAddOpen(copy);
    setDetailOpen(true);
  }
  const scope = client === "codebuddyIde" ? variantScope : undefined;
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const previewRequestId = useRef(0);
  const contextRef = useRef({ client, scope, selectedGroupId, sourceMemberId });
  contextRef.current = { client, scope, selectedGroupId, sourceMemberId };
  const listContextKey = `${client}:${scope ?? "all"}`;
  const detailContextKey = `${listContextKey}:${selectedGroupId ?? "none"}`;

  useEffect(() => {
    if (!selectedGroupId) { setCurrentAccounts([]); return; }
    let live = true;
    setCurrentAccounts([]);
    const reads = client === "workbuddy"
      ? [api.getStatus("cn").then((status) => ({ variant: "cn" as const, uid: status.current?.uid, running: status.running })),
        api.getStatus("ai").then((status) => ({ variant: "ai" as const, uid: status.current?.uid, running: status.running }))]
      : client === "codebuddyIde"
        ? [api.getCodebuddyCnIdeStatus().then((status) => ({ variant: "cn" as const, accountId: status.activeAccountId })),
          api.getCodebuddyIdeStatus().then((status) => ({ variant: "ai" as const, accountId: status.activeAccountId }))]
        : [api.getVscodeExtStatus().then((status) => ({ accountId: status.activeAccountId }))];
    void Promise.allSettled(reads).then((results) => {
      if (live) setCurrentAccounts(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    });
    return () => { live = false; };
  }, [client, selectedGroupId, detail]);

  useEffect(() => {
    if (accounts.length === 0) void fetchAll();
  }, [accounts.length, fetchAll]);

  const reloadGroups = useCallback(async () => {
    const key = `${client}:${scope ?? "all"}`;
    const requestId = ++listRequestId.current;
    setLoading(true);
    setLoadError(null);
    setStoreError(null);
    try {
      const result = await api.listSessionGroups(client, scope);
      if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}` !== key || listRequestId.current !== requestId) return;
      setGroups(result.groups);
      setStoreStatus(result.storeStatus);
      setStoreError(result.storeError ?? null);
    } catch (error) {
      if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}` !== key || listRequestId.current !== requestId) return;
      setGroups([]);
      setLoadError(api.asError(error));
    } finally {
      if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}` === key && listRequestId.current === requestId) setLoading(false);
    }
  }, [client, scope]);

  useEffect(() => {
    let live = true;
    const requestId = ++listRequestId.current;
    const key = listContextKey;
    setLoading(true);
    setLoadError(null);
    setDetail(null);
    setSelectedGroupId(null);
    previewRequestId.current += 1;
    setUnifyPlan(null);
    setUnifyLoading(null);
    api.listSessionGroups(client, scope).then((result) => {
      if (!live || listRequestId.current !== requestId || `${contextRef.current.client}:${contextRef.current.scope ?? "all"}` !== key) return;
      setGroups(result.groups);
      setStoreStatus(result.storeStatus);
      setStoreError(result.storeError ?? null);
    }).catch((error) => {
      if (!live || listRequestId.current !== requestId || `${contextRef.current.client}:${contextRef.current.scope ?? "all"}` !== key) return;
      setGroups([]);
      setLoadError(api.asError(error));
    }).finally(() => {
      if (live && listRequestId.current === requestId && `${contextRef.current.client}:${contextRef.current.scope ?? "all"}` === key) setLoading(false);
    });
    return () => { live = false; };
  }, [client, scope, listContextKey]);

  useEffect(() => {
    if (!selectedGroupId) {
      detailRequestId.current += 1;
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      setSourceMemberId("");
      setAddTargetId("");
      previewRequestId.current += 1;
      setUnifyPlan(null);
      setUnifyLoading(null);
      return;
    }
    let live = true;
    const requestId = ++detailRequestId.current;
    const key = detailContextKey;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    previewRequestId.current += 1;
    setUnifyPlan(null);
    setUnifyLoading(null);
    api.getSessionGroup(client, selectedGroupId, scope).then((result) => {
      if (!live || detailRequestId.current !== requestId || `${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` !== key) return;
      setDetail(result);
      setSourceMemberId(result.safeSourceMemberId ?? "");
      setAddTargetId(result.addTargets[0]?.id ?? "");
    }).catch((error) => {
      if (!live || detailRequestId.current !== requestId || `${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` !== key) return;
      setDetailError(api.asError(error));
    }).finally(() => {
      if (live && detailRequestId.current === requestId && `${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` === key) setDetailLoading(false);
    });
    return () => { live = false; };
  }, [client, scope, selectedGroupId, detailContextKey]);

  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const result = groups.filter((group) => {
      const matchesQuery = !needle || [group.title, group.projectLabel, ...group.accountNames].some((value) => value.toLocaleLowerCase().includes(needle));
      const matchesStatus = statusFilter === "all" || group.summaryStatus === statusFilter;
      return matchesQuery && matchesStatus;
    });
    result.sort((left, right) => sortOrder === "oldest" ? left.latestActivityAt - right.latestActivityAt : left.latestActivityAt === right.latestActivityAt ? left.title.localeCompare(right.title) : right.latestActivityAt - left.latestActivityAt);
    return result;
  }, [groups, query, statusFilter, sortOrder]);
  const pageCount = Math.max(1, Math.ceil(filteredGroups.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleGroups = filteredGroups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [query, statusFilter, sortOrder, client, scope]);

  function changeClient(value: string) {
    const next = value as SessionGroupClient;
    setClient(next);
    setDetailOpen(false);
    setSelectedGroupId(null);
    setDetail(null);
    previewRequestId.current += 1;
    setUnifyPlan(null);
    setUnifyLoading(null);
  }

  async function prepareUnify(source: SessionGroupMemberDetail) {
    if (!detail || !source.canBeSource || actionBusy || unifyLoading) return;
    const requestId = ++previewRequestId.current;
    const key = detailContextKey;
    const groupId = detail.groupId;
    const targets = detail.members.filter((member) => member.linkState === "active" && member.memberId !== source.memberId);
    setUnifyPlan(null);
    setUnifyLoading(source.memberId);
    const results = await Promise.allSettled(targets.map((target) => api.previewSessionGroupPair({
      client, groupId, sourceMemberId: source.memberId, targetMemberId: target.memberId, variantScope: scope,
    })));
    if (previewRequestId.current !== requestId || `${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` !== key) return;
    setUnifyLoading(null);
    setUnifyPlan({
      client, groupId, sourceMemberId: source.memberId, sourceName: source.accountName,
      targets: targets.map((target, index) => {
        const result = results[index];
        return { memberId: target.memberId, accountName: target.accountName,
          preview: result.status === "fulfilled" ? result.value : null,
          error: result.status === "rejected" ? api.asError(result.reason) : null };
      }),
    });
  }

  async function confirmUnify() {
    const plan = unifyPlan;
    if (!plan || !detail || plan.client !== client || plan.groupId !== detail.groupId || actionBusy) return;
    const actions = plan.targets.flatMap((target) => {
      const preview = target.preview;
      if (!preview || preview.verdict === "identical") return [];
      const mode: SessionSyncMode | undefined = ["fastForward", "overwrite", "unifyOverwrite"].find(
        (candidate) => preview.availableModes.includes(candidate as SessionSyncMode),
      ) as SessionSyncMode | undefined;
      return mode && preview.previewToken && preview.client === client && preview.groupId === plan.groupId
        && preview.sourceMemberId === plan.sourceMemberId && preview.targetMemberId === target.memberId
        ? [{ target, preview, mode }] : [];
    });
    if (plan.targets.some((target) => target.error || !target.preview
      || target.preview.client !== client || target.preview.groupId !== plan.groupId
      || target.preview.sourceMemberId !== plan.sourceMemberId || target.preview.targetMemberId !== target.memberId
      || (target.preview.verdict !== "identical" && !actions.some((action) => action.target.memberId === target.memberId)))) return;
    setUnifyPlan(null);
    setActionBusy(true);
    try {
      if (client === "workbuddy" && actions.length > 0) {
        const report = await api.syncSessionGroupUnify({
          client, groupId: plan.groupId, sourceMemberId: plan.sourceMemberId,
          targets: actions.map(({ target, preview, mode }) => ({ targetMemberId: target.memberId, previewToken: preview.previewToken!, mode })),
        });
        notifyResult(report);
      } else {
        const combined: { synced: unknown[]; skipped: unknown[]; errors: { error: string }[]; needsRecovery: boolean } = { synced: [], skipped: [], errors: [], needsRecovery: false };
        for (const { target, preview, mode } of actions) {
          try {
            const report = await api.syncSessionGroupPair({
              client, groupId: plan.groupId, sourceMemberId: plan.sourceMemberId, targetMemberId: target.memberId,
              previewToken: preview.previewToken!, mode, variantScope: scope,
            });
            combined.synced.push(...report.synced);
            combined.skipped.push(...report.skipped);
            combined.errors.push(...report.errors);
            combined.needsRecovery ||= Boolean(report.needsRecovery);
            if (report.needsRecovery) break;
          } catch (error) {
            combined.errors.push({ error: `${target.accountName}：${api.asError(error)}` });
            break;
          }
        }
        notifyResult(combined);
      }
      await reloadSelectedGroup();
    } catch (error) {
      toast.error("统一会话内容失败", { description: api.asError(error) });
    } finally {
      setActionBusy(false);
    }
  }

  async function syncSafeBatch() {
    if (!detail?.safeSourceMemberId || actionBusy) return;
    setActionBusy(true);
    try {
      const report = await api.syncSessionGroupSafeBatch(client, detail.groupId, scope);
      notifyResult(report);
      await reloadSelectedGroup();
    } catch (error) {
      toast.error("批量同步失败", { description: api.asError(error) });
    } finally {
      setActionBusy(false);
    }
  }

  async function addMember() {
    if (!detail || !sourceMemberId || !addTargetId || actionBusy) return;
    setActionBusy(true);
    try {
      const report = await api.addSessionGroupMember({
        client,
        groupId: detail.groupId,
        sourceMemberId,
        targetAccountId: addTargetId,
        variantScope: scope,
      });
      if (report.status === "linked") toast.success("已复制并添加到关联组");
      else if (report.status === "alreadyLinked") toast.info("该账号已在关联组中");
      else if (report.status === "copiedUnlinked") toast.warning("会话已复制，但没有建立关联", { description: JSON.stringify(report.linkErrors ?? []) });
      else toast.error("添加关联账号失败");
      await reloadSelectedGroup();
    } catch (error) {
      toast.error("添加关联账号失败", { description: api.asError(error) });
    } finally {
      setActionBusy(false);
    }
  }

  async function reloadSelectedGroup() {
    const key = `${client}:${scope ?? "all"}:${selectedGroupId ?? "none"}`;
    // An operation may finish after the user selected another group/client.
    if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` !== key || !selectedGroupId) return;
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setDetailError(null);
    previewRequestId.current += 1;
    setUnifyPlan(null);
    setUnifyLoading(null);
    await reloadGroups();
    if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` !== key) return;
    if (!selectedGroupId) return;
    try {
      const next = await api.getSessionGroup(client, selectedGroupId, scope);
      if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` !== key || detailRequestId.current !== requestId) return;
      setDetail(next);
      setSourceMemberId(next.safeSourceMemberId ?? sourceMemberId);
      setAddTargetId(next.addTargets[0]?.id ?? "");
      previewRequestId.current += 1;
      setUnifyPlan(null);
      setUnifyLoading(null);
    } catch (error) {
      if (`${contextRef.current.client}:${contextRef.current.scope ?? "all"}:${contextRef.current.selectedGroupId ?? "none"}` === key && detailRequestId.current === requestId) setDetailError(api.asError(error));
    } finally {
      if (detailRequestId.current === requestId) setDetailLoading(false);
    }
  }

  const detailPanel = (
    <GroupDetailPanel
      client={client} detail={detail} sourceMemberId={sourceMemberId}
      currentAccounts={currentAccounts}
      setSourceMemberId={setSourceMemberId}
      addTargetId={addTargetId} setAddTargetId={setAddTargetId}
      unifyPlan={unifyPlan} unifyLoading={unifyLoading} setUnifyPlan={setUnifyPlan} busy={actionBusy || detailLoading || !!detailError}
      error={detailError} loading={detailLoading} onClose={closeDetail}
      onRetry={() => { setDetailError(null); void reloadSelectedGroup(); }}
      onPrepareUnify={prepareUnify} onConfirmUnify={confirmUnify} onBatchSync={syncSafeBatch} onAdd={addMember}
      addOpen={addOpen} setAddOpen={setAddOpen} fullPage={false}
    />
  );
  const statusOptions = [
    ["all", "全部"], ["behind", "待同步"], ["diverge", "有分歧"], ["latest", "内容一致"],
    ["missing", "内容缺失"], ["unknown", "无法确认"],
  ];
  const copyGroup = visibleGroups.find((group) => group.groupId === selectedGroupId);
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((value) => value === 1 || value === pageCount || Math.abs(value - currentPage) <= 1);

  return (
    <div data-detail-mode={detailMode} className="mx-auto w-full max-w-[1180px] min-w-0 px-6 py-8 sm:px-8 sm:py-9">
      <div ref={rootRef} className="flex min-w-0 flex-col">
        <header className="mb-6">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-[28px] font-semibold tracking-tight">会话管理</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">统一管理各账号下的会话副本，按需复制或同步。</p>
            </div>
            <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => void (selectedGroupId ? reloadSelectedGroup() : reloadGroups())} disabled={loading || detailLoading}><RefreshCw className={loading ? "animate-spin" : undefined} />刷新</Button>
              <Button size="sm" className="shrink-0 bg-brand text-brand-foreground hover:bg-brand/90" disabled={!copyGroup || loading} title={copyGroup ? `复制「${copyGroup.title}」` : "请先选择当前页的会话"} onClick={() => copyGroup && openDetail(copyGroup.groupId, true)}><Copy />复制会话</Button>
            </div>
          </div>
          <Tabs value={client} onValueChange={changeClient} className="mt-4">
            <TabsList aria-label="会话客户端" className="grid h-auto w-full grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2 bg-transparent p-0">
              {CLIENTS.map((item) => <TabsTrigger key={item.id} value={item.id} className="relative h-auto min-w-0 justify-start gap-3 rounded-lg border border-border bg-background px-3 py-4 text-left data-[state=active]:border-brand data-[state=active]:bg-brand/5 data-[state=active]:shadow-sm">
                <ClientMark client={item.id} />
                <span className="min-w-0"><span className="block truncate text-sm font-semibold text-foreground">{item.title}</span><span className="mt-1 block truncate text-xs font-normal text-muted-foreground">{item.id === "workbuddy" ? "国内版 · 国际版" : item.id === "codebuddyIde" ? "国内版 / 国际版" : "VS Code"}</span></span>
                {client === item.id && <CheckCircle2 className="absolute right-2 top-2 size-3.5 text-brand" />}
              </TabsTrigger>)}
            </TabsList>
          </Tabs>
        </header>
        <section aria-labelledby="session-groups-title" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h2 id="session-groups-title" className="text-base font-semibold tracking-tight">{CLIENTS.find((item) => item.id === client)?.title} 会话</h2>
            <Badge variant="secondary" className="h-6 min-w-6 rounded-full border-0 px-1.5 text-[11px] tabular-nums text-muted-foreground shadow-none" aria-label={`${groups.length} 个会话组`}>{groups.length}</Badge>
            <span className="text-xs text-muted-foreground">{client === "workbuddy" ? "支持国内版与国际版关联" : "按客户端独立管理"}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="relative min-w-0 basis-48 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话、项目或账号…" aria-label="搜索会话、项目或账号" className="h-10 bg-background pl-10" /></div>
            {client === "codebuddyIde" && <Select value={variantScope} onValueChange={(value) => { setVariantScope(value as WbVariant); setSelectedGroupId(null); setDetailOpen(false); }}><SelectTrigger className="h-10 w-36 bg-background" aria-label="选择 CodeBuddy IDE 档位"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cn">国内版</SelectItem><SelectItem value="ai">国际版</SelectItem></SelectContent></Select>}
          </div>
          <div className="my-4 flex flex-wrap items-center justify-between gap-2">
            <Tabs value={statusFilter} onValueChange={setStatusFilter} className="min-w-0 max-w-full gap-0">
              <TabsList className="h-auto max-w-full flex-wrap justify-start gap-0.5" aria-label="按状态筛选">
                {statusOptions.filter(([value]) => ["all", "behind", "diverge", "latest"].includes(value) || value === statusFilter || groups.some((group) => group.summaryStatus === value)).map(([value, label]) => <TabsTrigger key={value} value={value} className="h-8 gap-1.5 px-2.5">
                  {label}<span className={`rounded-full px-1.5 text-[11px] tabular-nums ${statusFilter === value ? "bg-muted" : "bg-background/70"}`}>{value === "all" ? groups.length : groups.filter((group) => group.summaryStatus === value).length}</span>
                </TabsTrigger>)}
              </TabsList>
            </Tabs>
            <Select value={sortOrder} onValueChange={setSortOrder}><SelectTrigger size="sm" className="w-28 border-0 bg-transparent shadow-none" aria-label="排序方式"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="recent">最近更新</SelectItem><SelectItem value="oldest">最早更新</SelectItem></SelectContent></Select>
          </div>
          {(storeStatus === "unavailable" || storeError) && <p role="status" className="mb-3 rounded-lg border border-amber-500/30 p-3 text-sm text-muted-foreground">{storeError ?? "关联组存储暂不可用，当前只展示可读取的数据。"}</p>}
          {loadError && <div role="alert" className="mb-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{loadError}<Button variant="outline" size="sm" className="ml-2" onClick={() => void reloadGroups()}>重试</Button></div>}
          {loading ? <GroupSkeleton /> : filteredGroups.length === 0 ? <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center"><Layers3 className="size-7 text-muted-foreground" /><h3 className="mt-3 text-sm font-medium">{groups.length === 0 ? "还没有关联会话组" : "没有符合条件的会话"}</h3><p className="mt-2 text-sm text-muted-foreground">{groups.length === 0 ? "从账号切换时复制会话后，关联组会显示在这里。" : "试试其它关键词或筛选条件。"}</p></div> : <div className={`grid min-w-0 gap-3 ${contentWidth >= 600 ? "grid-cols-2" : "grid-cols-1"}`}>{visibleGroups.map((group) => <SessionGroupCard key={group.key} group={group} selected={group.groupId === selectedGroupId} onSelect={() => openDetail(group.groupId)} />)}</div>}
          {!loading && filteredGroups.length > 0 && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>显示 {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredGroups.length)}，共 {filteredGroups.length} 个会话</span><nav aria-label="会话分页" className="flex flex-wrap items-center gap-1.5"><Button variant="outline" size="icon" className="size-8" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft /></Button>{pages.map((value, index) => <span key={value} className="flex items-center gap-1.5">{index > 0 && value - pages[index - 1] > 1 && <span>…</span>}<Button variant={value === currentPage ? "default" : "outline"} className={`size-8 p-0 ${value === currentPage ? "bg-brand text-brand-foreground hover:bg-brand/90" : ""}`} aria-label={`第 ${value} 页`} aria-current={value === currentPage ? "page" : undefined} onClick={() => setPage(value)}>{value}</Button></span>)}<Button variant="outline" size="icon" className="size-8" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight /></Button></nav></div>}
        </section>
      </div>
      <Dialog open={detailOpen} onOpenChange={(open) => { if (!open) closeDetail(); }}>
        <DialogContent showCloseButton={false} aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); if (!detailOpen) openerRef.current?.focus({ preventScroll: true }); }} className="session-detail-modal flex flex-col gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">会话详情</DialogTitle>{detailPanel}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClientMark({ client, variantScope }: { client: SessionGroupClient; variantScope?: WbVariant }) {
  if (client === "workbuddy") return variantScope === "ai" ? <WorkBuddyAiMark size={34} /> : <WorkBuddyMark size={34} />;
  if (client === "codebuddyIde") return <CodeBuddyCnIdeMark size={34} />;
  return <VscodeExtMark size={34} className="text-foreground" />;
}

function GroupSkeleton() {
  return <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" aria-label="正在加载会话组">
    {Array.from({ length: 4 }, (_, index) => <Card key={index} className="gap-3 rounded-xl py-3 shadow-none"><CardContent className="space-y-3 px-3"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-7 w-full" /></CardContent></Card>)}
  </div>;
}

function SessionGroupCard({ group, selected, onSelect }: { group: SessionGroupSummary; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`min-w-0 cursor-pointer rounded-lg border bg-card px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-brand shadow-sm" : "border-border hover:border-brand/50"}`}>
    <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground"><span className="flex min-w-0 items-center gap-2"><Folder className="size-4 shrink-0" /><span className="truncate" title={group.projectLabel}>{group.projectLabel || "未标记项目"}</span></span><span className="shrink-0" title={formatDate(group.latestActivityAt)}>{relativeDate(group.latestActivityAt)}</span></div>
    <h3 className="my-3 truncate text-base font-semibold" title={group.title}>{group.title}</h3>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><span className="flex items-center gap-2" title={group.accountNames.join("、")}><MessageCircle className="size-4" />{group.memberCount} 个账号</span><span className="flex min-w-0 items-center gap-2 text-xs"><span className={`size-2 shrink-0 rounded-full ${group.summaryStatus === "latest" ? "bg-brand" : group.summaryStatus === "behind" ? "bg-amber-500" : group.summaryStatus === "diverge" ? "bg-destructive" : "bg-muted-foreground"}`} /><span className="truncate" title={group.summaryText}>{{ latest: "内容一致", behind: "待同步", diverge: "有分歧", missing: "内容缺失", unknown: "无法确认" }[group.summaryStatus]}</span></span></div>
  </button>;
}

function relativeDate(timestamp: number): string {
  if (!timestamp) return "—";
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  return formatDate(timestamp);
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function notifyResult(report: { synced?: unknown[]; skipped?: unknown[]; errors?: { error: string }[]; needsRecovery?: boolean; temporaryFiles?: { reason: string }[]; restartedVariants?: WbVariant[] }, targetName?: string) {
  const synced = report.synced?.length ?? 0;
  const skipped = report.skipped?.length ?? 0;
  const errors = report.errors ?? [];
  if (synced > 0) toast.success(targetName ? `已同步到「${targetName}」` : `已同步 ${synced} 个会话`, { description: `完成 ${synced} 项${report.restartedVariants?.length ? `，已重新打开 ${report.restartedVariants.map(variantLabel).join("、")}` : ""}` });
  if (skipped > 0) toast.warning(`有 ${skipped} 项跳过`, { description: "预览过期或复核后不再符合安全条件的项不会计为成功。" });
  if (errors.length > 0) toast.error("部分会话同步失败", { description: errors.map((item) => item.error).join("；") });
  if (report.needsRecovery) toast.error("会话操作待恢复", { description: report.temporaryFiles?.map((item) => item.reason).join("；") || "已保留恢复所需材料。" });
  if (synced === 0 && skipped === 0 && errors.length === 0 && !report.needsRecovery) toast.info("当前没有需要同步的副本");
}
