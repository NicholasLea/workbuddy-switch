import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Copy, Loader2, RefreshCw } from "lucide-react";
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
import type { AccountMeta, Session } from "@/lib/types";
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
  /** 行尾副本标记（本次页面会话内有效）。 */
  const [marks, setMarks] = useState<Map<string, CopyMark>>(new Map());

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

  // 目标账号不能与来源相同：来源变化后清掉失效的目标选择。
  useEffect(() => {
    if (targetId && targetId === sourceId) setTargetId("");
  }, [sourceId, targetId]);

  const source = accounts.find((account) => account.id === sourceId) ?? null;
  const target = accounts.find((account) => account.id === targetId) ?? null;
  const targetOptions = accounts.filter((account) => account.id !== sourceId);
  const noAccounts = accounts.length === 0;
  const ready = Boolean(source && target) && selected.size > 0 && !copying;

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
