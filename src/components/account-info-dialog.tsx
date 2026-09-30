import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/api";
import { accountVariant, variantLabel } from "@/lib/variant";
import type { AccountMeta, DisplayField } from "@/lib/types";

/** 备注长度上限：与后端 NOTE_MAX_CHARS 保持一致。 */
const NOTE_MAX_LENGTH = 24;

const FIELD_OPTIONS: Array<{ value: DisplayField; label: string }> = [
  { value: "nickname", label: "账号名" },
  { value: "phone", label: "手机号" },
  { value: "note", label: "备注" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标账号；为空时不渲染内容。 */
  account: AccountMeta | null;
  /** 保存成功后回调（携带更新后的账号元数据）。 */
  onSaved?: (account: AccountMeta) => void;
}

/**
 * 账号信息弹框：查看账号信息、编辑本地备注、选择卡片显示字段。
 * 备注与显示字段只保存在本机账号库，不影响官方登录数据。
 */
export function AccountInfoDialog({ open, onOpenChange, account, onSaved }: Props) {
  const [note, setNote] = useState("");
  const [field, setField] = useState<DisplayField>("nickname");
  const [busy, setBusy] = useState(false);

  // 每次打开按目标账号重置草稿状态。
  useEffect(() => {
    if (open && account) {
      setNote(account.note ?? "");
      setField(account.displayField ?? "nickname");
      setBusy(false);
    }
  }, [open, account]);

  if (!account) return null;

  // 闭包内收窄：函数参数在闭包里不被 TS 收窄，先取到局部常量。
  const accountId = account.id;
  const hasPhone = Boolean(account.phoneNumber);
  // 手机号不可用时回退账号名（含用户此前选择 phone 的存量数据）。
  const effectiveField: DisplayField = field === "phone" && !hasPhone ? "nickname" : field;

  const infoRows: Array<[string, string | null]> = [
    ["账号名", account.nickname],
    ["手机号", account.phoneNumber ?? null],
    ["企业名", account.enterpriseName],
    ["UID", account.uid],
    ["档位", variantLabel(accountVariant(account))],
  ];

  async function save() {
    setBusy(true);
    try {
      const res = await api.updateAccountDisplay(accountId, {
        note: note.trim() || null,
        displayField: effectiveField,
      });
      onSaved?.(res.account);
      toast.success("账号信息已保存");
      onOpenChange(false);
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>账号信息</DialogTitle>
          <DialogDescription>查看账号信息；备注与显示字段仅保存在本机。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs">
            {infoRows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 truncate font-medium" title={value ?? ""}>
                  {value || "—"}
                </dd>
              </div>
            ))}
          </dl>

          <div className="space-y-1.5">
            <Label htmlFor="account-note">备注</Label>
            <div className="flex items-center gap-2">
              <Input
                id="account-note"
                value={note}
                maxLength={NOTE_MAX_LENGTH}
                placeholder={`最多 ${NOTE_MAX_LENGTH} 个字符`}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={!note}
                onClick={() => setNote("")}
              >
                清空
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>卡片显示</Label>
            <div className="flex flex-wrap gap-2">
              {FIELD_OPTIONS.map((opt) => {
                const disabled = opt.value === "phone" && !hasPhone;
                return (
                  <Button
                    key={opt.value}
                    type="button"
                    size="sm"
                    variant={effectiveField === opt.value ? "default" : "outline"}
                    disabled={disabled}
                    aria-pressed={effectiveField === opt.value}
                    onClick={() => setField(opt.value)}
                  >
                    {opt.label}
                  </Button>
                );
              })}
            </div>
            {!hasPhone && (
              <p className="text-xs text-muted-foreground">该账号没有手机号，无法按手机号显示。</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
