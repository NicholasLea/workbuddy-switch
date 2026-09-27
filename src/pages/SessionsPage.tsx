import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ArrowRight, Copy, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { DemoAction } from "@/components/demo-action";
import { SessionTreeList, buildSessionTree } from "@/components/session-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import * as api from "@/lib/api";
import { accountVariant, variantLabel } from "@/lib/variant";
import type {
  AccountMeta,
  Session,
  SessionLinkPreviewGroup,
  SessionLinksPreview,
  SessionSyncMode,
  SessionSyncSelection,
} from "@/lib/types";
import { useAccountsStore } from "@/stores/accounts";

/** 行尾副本标记：本次页面会话内复制过（或确认已有副本）的会话 → 目标账号与时间。 */
type CopyMark = { kind: "copied" | "linked"; accountId: string; label: string; at: number };

/** 列表骨架 / 空态的固定最小高度，避免加载完成时页面跳动。 */
const LIST_MIN_H = "min-h-[min(12rem,32vh)]";

export default function SessionsPage() {
  const { accounts, status, fetchAll } = useAccountsStore();

  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 展开的节点：任务 / 空间 / 文件夹。默认全部收起。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copying, setCopying] = useState(false);
  /** 同步执行中（单行或批量共用，防止并发重复提交）。 */
  const [syncing, setSyncing] = useState(false);
  /** 行尾副本标记（本次页面会话内有效）。 */
  const [marks, setMarks] = useState<Map<string, CopyMark>>(new Map());
  /** 源 ↔ 目标 的副本状态预览（只读判定；两个账号都选定后才请求）。 */
  const [preview, setPreview] = useState<SessionLinksPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** 复制成功后自增，触发预览刷新。 */
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);

  // 账号列表与当前登录态：直接打开本页时不依赖账号页先加载。
  useEffect(() => {
    if (accounts.length === 0) void fetchAll();
  }, [accounts.length, fetchAll]);

  // 默认来源账号：优先当前登录账号，否则列表第一个。
  useEffect(() => {
    if (sourceId || accounts.length === 0) return;
    const currentUid = status?.current?.uid ?? null;
    const preferred = accounts.find((account) => account.uid && account.uid === currentUid) ?? accounts[0];
    setSourceId(preferred.id);
  }, [accounts, status, sourceId]);

  const loadSessions = useCallback(async (accountId: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.listAccountSessions(accountId);
      setSessions(res.sessions);
      // 页面场景默认全展开（切号弹窗空间小，保持默认收起）。
      const keys = new Set<string>();
      for (const kind of buildSessionTree(res.sessions)) {
        keys.add(kind.key);
        for (const folder of kind.folders ?? []) keys.add(folder.key);
      }
      setExpanded(keys);
    } catch (cause) {
      setSessions([]);
      setLoadError(api.asError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // 来源账号变化：清空勾选与标记，重新加载会话。
  useEffect(() => {
    if (!sourceId) return;
    setSelected(new Set());
    setMarks(new Map());
    void loadSessions(sourceId);
  }, [sourceId, loadSessions]);

  // 目标账号不能与来源相同：来源变化后自动选一个不同的账号，副本状态一进页面即可见
  // （复制仍需勾选会话，误触门槛不变）。
  useEffect(() => {
    if (accounts.length < 2) return;
    if (targetId && targetId !== sourceId) return;
    const candidate = accounts.find((account) => account.id !== sourceId);
    if (candidate) setTargetId(candidate.id);
  }, [accounts, sourceId, targetId]);

  // 两个账号都选定后加载副本状态预览（只读）；账号组合变化或复制成功后重新加载。
  useEffect(() => {
    if (!sourceId || !targetId) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    api
      .sessionLinksPreviewCross(sourceId, targetId)
      .then((report) => {
        if (cancelled) return;
        setPreview(report);
        setPreviewError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(api.asError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, targetId, previewRefreshKey]);

  const source = accounts.find((account) => account.id === sourceId) ?? null;
  const target = accounts.find((account) => account.id === targetId) ?? null;
  const targetOptions = accounts.filter((account) => account.id !== sourceId);
  const noAccounts = accounts.length === 0;
  const ready = Boolean(source && target) && selected.size > 0 && !copying;

  // 会话行 → 预览组（按来源成员的 sessionId 对齐；无组的会话表示尚未复制过）。
  const previewBySession = useMemo(() => {
    const map = new Map<string, SessionLinkPreviewGroup>();
    for (const group of preview?.groups ?? []) {
      const sessionId = group.source?.sessionId;
      if (sessionId) map.set(sessionId, group);
    }
    return map;
  }, [preview]);

  // 副本状态整体不可用时的提示（行尾判定不显示，避免误导）。
  const previewNote = (() => {
    if (noAccounts || !targetId) return null;
    if (previewError) return `副本状态暂不可用：${previewError}`;
    if (preview && !preview.supported) return "该档位暂不支持会话同步，副本状态不可用。";
    if (preview?.storeStatus === "unavailable") {
      return preview.storeError ?? "同步记录不可用，副本状态暂不可用。";
    }
    return null;
  })();

  // 组 id → 标题（同步结果的错误提示按组展示）。
  const titleByGroupId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of preview?.groups ?? []) map.set(group.groupId, group.title);
    return map;
  }, [preview]);

  // 可直接快进的组（批量同步用；冲突组需在行内逐条显式覆盖）。
  const fastForwardGroups = useMemo(
    () =>
      (preview?.groups ?? []).filter(
        (group) => group.verdict === "fastForward" && Boolean(group.previewToken),
      ),
    [preview],
  );

  function toggleSession(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(ids: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = ids.length > 0 && ids.every((id) => next.has(id));
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function doCopy() {
    if (!source || !target || selected.size === 0) return;
    setCopying(true);
    try {
      const ids = [...selected];
      const report = await api.copySessionsCross(source.id, target.id, ids);
      const targetLabel = accountLabel(target);
      const at = Date.now();
      setMarks((prev) => {
        const next = new Map(prev);
        for (const item of report.copied ?? []) {
          next.set(item.id, { kind: "copied", accountId: target.id, label: targetLabel, at });
        }
        for (const item of report.alreadyLinked ?? []) {
          next.set(item.id, { kind: "linked", accountId: target.id, label: targetLabel, at });
        }
        return next;
      });
      // 复制改变了两边内容：刷新副本状态判定。
      setPreviewRefreshKey((key) => key + 1);
      const copiedCount = report.copied?.length ?? 0;
      const linkedCount = report.alreadyLinked?.length ?? 0;
      const parts: string[] = [];
      if (copiedCount > 0) parts.push(`已复制 ${copiedCount} 个会话`);
      if (linkedCount > 0) parts.push(`${linkedCount} 个之前已复制过（复用已有副本）`);
      if (parts.length > 0) {
        toast.success(`已复制到「${targetLabel}」`, { description: parts.join("；") });
      }
      // 失败与未完成必须显式提示，不能静默当成成功。
      const errors = report.errors ?? [];
      if (errors.length > 0) {
        const sessionLabel = (id: string) => sessions.find((item) => item.id === id)?.title || id;
        toast.error("部分会话未复制", {
          description: errors.map((item) => `${sessionLabel(item.id)}：${item.error}`).join("；"),
        });
      }
      if (report.needsRecovery) {
        toast.error("有会话操作没有完成", {
          description: "已保留操作记录与备份，下次操作会先恢复；恢复完成前不会再改动目标账号的内容。",
        });
      }
    } catch (cause) {
      toast.error("会话复制失败", { description: api.asError(cause) });
    } finally {
      setCopying(false);
    }
  }

  /** 一条同步选择：凭据必须原样回传（后端逐项复核，过期即跳过）。 */
  function selectionOf(
    group: SessionLinkPreviewGroup,
    mode: SessionSyncMode,
  ): SessionSyncSelection {
    return { groupId: group.groupId, previewToken: group.previewToken ?? "", mode };
  }

  /** 执行同步（单行或批量）：结果逐类提示（成功/跳过/失败/未完成），绝不静默。 */
  async function doSync(selections: SessionSyncSelection[]) {
    if (!source || !target || selections.length === 0 || syncing) return;
    setSyncing(true);
    try {
      const report = await api.sessionSyncCross(source.id, target.id, selections);
      const synced = report.synced ?? [];
      const skipped = report.skipped ?? [];
      const errors = report.errors ?? [];
      if (synced.length > 0) {
        toast.success(`已同步到「${accountLabel(target)}」`, {
          description: `已同步 ${synced.length} 个会话`,
        });
      }
      if (skipped.length > 0) {
        toast.warning("部分会话未同步（内容可能已变化）", {
          description: skipped.map((item) => item.message).join("；"),
        });
      }
      if (errors.length > 0) {
        const label = (groupId?: string) => (groupId && titleByGroupId.get(groupId)) || groupId || "会话";
        toast.error("部分会话同步失败", {
          description: errors
            .map((item) => `${label(item.groupId)}：${item.error}`)
            .join("；"),
        });
      }
      if (report.needsRecovery) {
        toast.error("有会话操作没有完成", {
          description:
            "已保留操作记录与备份，下次操作会先恢复；恢复完成前不会再改动目标账号的内容。",
        });
      }
    } catch (cause) {
      toast.error("会话同步失败", { description: api.asError(cause) });
    } finally {
      setSyncing(false);
      // 无论结果如何都刷新判定（部分成功也要让新状态可见）。
      setPreviewRefreshKey((key) => key + 1);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-[28px] font-semibold tracking-tight">会话管理</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        选择来源账号的会话，复制到另一个账号；支持国内版与国际版账号之间复制。
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Select value={sourceId} onValueChange={setSourceId} disabled={noAccounts}>
          <SelectTrigger size="sm" className="w-56" aria-label="来源账号">
            <SelectValue placeholder="选择来源账号" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                <AccountOption account={account} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Select value={targetId} onValueChange={setTargetId} disabled={targetOptions.length === 0}>
          <SelectTrigger size="sm" className="w-56" aria-label="目标账号">
            <SelectValue placeholder="选择目标账号" />
          </SelectTrigger>
          <SelectContent>
            {targetOptions.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                <AccountOption account={account} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadSessions(sourceId)}
            disabled={!sourceId || loading}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
          <DemoAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void doSync(fastForwardGroups.map((group) => selectionOf(group, "fastForward")))
              }
              disabled={syncing || fastForwardGroups.length === 0}
            >
              <ArrowLeftRight />
              同步落后副本（{fastForwardGroups.length}）
            </Button>
          </DemoAction>
          <DemoAction>
            <Button onClick={() => void doCopy()} disabled={!ready}>
              {copying ? <Loader2 className="animate-spin" /> : <Copy />}
              开始复制{selected.size > 0 ? `（${selected.size}）` : ""}
            </Button>
          </DemoAction>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardDescription>
            {noAccounts
              ? "尚未添加账号：请先在「账号管理」页添加国内版或国际版账号。"
              : source
                ? `来源：${accountLabel(source)}（${variantLabel(accountVariant(source))}）${loading ? "" : ` · ${sessions.length} 个会话`}`
                : "选择来源账号后列出会话。"}
          </CardDescription>
          {previewNote && (
            <CardDescription className="text-amber-700 dark:text-amber-400">
              {previewNote}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {noAccounts ? null : loading ? (
            <div className={`space-y-2 ${LIST_MIN_H}`} aria-hidden="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : loadError ? (
            <p
              className={`flex items-center justify-center px-3 text-center text-sm text-amber-700 dark:text-amber-400 ${LIST_MIN_H}`}
            >
              {loadError}
            </p>
          ) : sessions.length === 0 ? (
            <p
              className={`flex items-center justify-center px-3 text-center text-sm text-muted-foreground ${LIST_MIN_H}`}
            >
              该账号暂无会话。
            </p>
          ) : (
            <SessionTreeList
              sessions={sessions}
              selected={selected}
              expanded={expanded}
              onToggleSession={toggleSession}
              onToggleGroup={toggleGroup}
              onToggleExpanded={toggleExpanded}
              renderTrailing={(session) => {
                // 有副本组的会话以真实判定为准；刚复制、预览尚未覆盖时回落到操作标记。
                const group = previewBySession.get(session.id);
                if (group) {
                  const text = verdictTrailingText(group);
                  const action = actionFor(group);
                  if (!text && !action) return null;
                  return (
                    <span className="flex shrink-0 items-center gap-2">
                      {text && (
                        <span
                          className={`text-[11px] tabular-nums ${
                            group.verdict === "diverge"
                              ? "text-amber-700 dark:text-amber-400"
                              : "text-muted-foreground"
                          }`}
                        >
                          {text}
                        </span>
                      )}
                      {action && (
                        <DemoAction>
                          <Button
                            variant={group.verdict === "diverge" ? "outline" : "secondary"}
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={syncing}
                            onClick={() => void doSync([selectionOf(group, action.mode)])}
                          >
                            {action.label}
                          </Button>
                        </DemoAction>
                      )}
                    </span>
                  );
                }
                const mark = marks.get(session.id);
                if (!mark) return null;
                return (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {mark.kind === "copied" ? "已复制" : "已有副本"} → {mark.label} · {formatTime(mark.at)}
                  </span>
                );
              }}
              className={LIST_MIN_H}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 账号展示名：昵称 → 邮箱 → uid（与账号页、切号弹窗同口径）。 */
function accountLabel(account: AccountMeta): string {
  return account.nickname || account.email || account.uid || account.id;
}

/** 账号选项：名称 + 档位徽标（两档混排时一眼可辨）。 */
function AccountOption({ account }: { account: AccountMeta }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{accountLabel(account)}</span>
      <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px] font-normal">
        {variantLabel(accountVariant(account))}
      </Badge>
    </span>
  );
}

/** 复制时间：HH:mm（本地时区）。 */
function formatTime(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 行内动作：可快进驻「同步」，冲突需显式覆盖（一致/目标更新/未知不给动作）。 */
function actionFor(
  group: SessionLinkPreviewGroup,
): { label: string; mode: SessionSyncMode } | null {
  if (!group.previewToken) return null;
  if (group.verdict === "fastForward") return { label: "同步", mode: "fastForward" };
  if (group.verdict === "diverge") return { label: "覆盖目标", mode: "overwrite" };
  return null;
}

/**
 * 行尾判定文案（只读展示）：
 * 判定口径与后端 `decide_sync` 一致，`extraA` 是来源独有、`extraB` 是目标独有记录数。
 */
function verdictTrailingText(group: SessionLinkPreviewGroup): string | null {
  switch (group.verdict) {
    case "identical":
      return "已一致";
    case "fastForward":
      return group.extraA > 0 ? `目标落后 ${group.extraA} 条` : "目标落后";
    case "ahead":
      return group.extraB > 0 ? `目标更新 ${group.extraB} 条` : "目标有更新";
    case "diverge":
      return "两边都有改动";
    case "unknown":
      return "状态未知";
    default:
      return null;
  }
}
