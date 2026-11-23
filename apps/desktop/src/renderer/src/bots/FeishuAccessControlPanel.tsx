import { useMemo, useState } from "react";
import { Check, Plus, Shield, ShieldAlert, ShieldCheck, Trash2, UserCheck } from "lucide-react";
import type {
  BotFeishuAdmin,
  BotFeishuRecentSender,
  FeishuAccessPolicy,
} from "../../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale } from "../locale";

export function accessPolicyLabel(
  policy: FeishuAccessPolicy,
  t: (zh: string, en: string) => string,
): string {
  switch (policy) {
    case "admins_only":
      return t("仅管理员可用", "Admins only");
    case "admins_dm_all_groups":
      return t("私聊仅管理员 · 群全员", "Admin DM · Group all");
    case "everyone":
      return t("全员可用", "Everyone");
  }
}

export function FeishuAccessControlPanel({
  accessPolicy,
  adminUsers,
  recentSenders = [],
  disabled = false,
  onChange,
}: {
  accessPolicy: FeishuAccessPolicy;
  adminUsers: BotFeishuAdmin[];
  recentSenders?: BotFeishuRecentSender[];
  disabled?: boolean;
  onChange: (nextPolicy: FeishuAccessPolicy, nextAdmins: BotFeishuAdmin[]) => void;
}) {
  const { t } = useLocale();
  const [draftOpenId, setDraftOpenId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const adminSet = useMemo(
    () => new Set(adminUsers.map((admin) => admin.openId)),
    [adminUsers],
  );

  const addAdmin = (openIdRaw: string, nameRaw?: string | null): boolean => {
    const cleanId = openIdRaw.trim();
    if (!cleanId) {
      setLocalError(t("请先填写飞书 Open ID（如 ou_xxx）。", "Enter a Feishu Open ID (e.g. ou_xxx)."));
      return false;
    }
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(cleanId)) {
      setLocalError(
        t(
          "Open ID 仅支持字母、数字、点、下划线和短横线。",
          "Open ID can only contain letters, digits, dots, underscores, and hyphens.",
        ),
      );
      return false;
    }
    setLocalError(undefined);
    const cleanName = nameRaw?.trim() || null;
    if (adminSet.has(cleanId)) {
      if (cleanName) {
        onChange(
          accessPolicy,
          adminUsers.map((item) =>
            item.openId === cleanId ? { ...item, name: cleanName } : item,
          ),
        );
      }
      return true;
    }
    onChange(accessPolicy, [...adminUsers, { openId: cleanId, name: cleanName }]);
    return true;
  };

  const removeAdmin = (openId: string): void => {
    setLocalError(undefined);
    onChange(
      accessPolicy,
      adminUsers.filter((item) => item.openId !== openId),
    );
  };

  const policyOptions: ReadonlyArray<{
    id: FeishuAccessPolicy;
    title: string;
    desc: string;
  }> = [
    {
      id: "admins_only",
      title: t("仅管理员可用", "Admins only"),
      desc: t(
        "严格模式：仅列表内的管理员可在私聊或群聊中唤醒，其他成员自动拦截。",
        "Strict: only authorized admins can use this Bot in DMs and groups.",
      ),
    },
    {
      id: "admins_dm_all_groups",
      title: t("私聊仅管理员 · 群全员可用", "Admin DM · Everyone in groups"),
      desc: t(
        "私聊仅限管理员；群聊中全员可正常提问，但 /new、/status 仅限管理员。",
        "DMs restricted to admins; group members can chat while admin commands stay protected.",
      ),
    },
    {
      id: "everyone",
      title: t("全员可用", "Everyone"),
      desc: t(
        "所有人均可对话；一旦配置管理员，/new、/status 等管理指令将仅限管理员执行。",
        "Open to everyone; configuring admins restricts /new and /status commands to admins.",
      ),
    },
  ];

  return (
    <div className="grid gap-6">
      {/* 1. Policy cards */}
      <div className="grid gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-xs font-semibold text-foreground">
            {t("访问权限策略", "Access Policy")}
          </strong>
          <span className="text-[11px] text-muted-foreground">
            {t("切换后立即生效，不会断开飞书连接", "Takes effect live without reconnecting")}
          </span>
        </div>

        <div className="bot-policy-cards" role="radiogroup" aria-label={t("飞书使用权限策略", "Feishu access policy")}>
          {policyOptions.map((option) => {
            const active = accessPolicy === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className="bot-policy-card"
                data-active={active}
                onClick={() => onChange(option.id, adminUsers)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">{option.title}</span>
                  <span className="bot-policy-check" data-active={active} aria-hidden="true">
                    {active && <Check className="size-3" />}
                  </span>
                </div>
                <span className="text-[11px] leading-relaxed text-muted-foreground text-left">
                  {option.desc}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2.5 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="grid gap-0.5">
            <strong className="font-medium text-foreground">
              {t("非管理员防篡改保护（始终开启）", "Non-admin tamper protection (always on)")}
            </strong>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "普通成员无法立群规、加回复前缀、切换“超级安全模式”或修改全局/群记忆；网关前置拦截 + 记忆与规则文件自动回滚双保险。",
                "Non-admins cannot set group rules, output prefixes, safety modes, or edit shared memories; protected by gateway pre-checks and automatic file rollback.",
              )}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Admins list + manual add */}
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-xs font-semibold text-foreground">
            {t(`管理员白名单 (${adminUsers.length})`, `Authorized Admins (${adminUsers.length})`)}
          </strong>
          <span className="text-[11px] text-muted-foreground">
            {t("在飞书对 Bot 发送 /whoami 可获取个人 Open ID", "Send /whoami in Feishu to look up an Open ID")}
          </span>
        </div>

        {adminUsers.length > 0 ? (
          <div className="bot-person-list">
            {adminUsers.map((admin) => (
              <div key={admin.openId} className="bot-person-row">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="bot-person-avatar" data-role="admin">
                    <ShieldCheck className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 grid gap-0.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {admin.name?.trim() || t("未命名管理员", "Unnamed admin")}
                    </span>
                    <code className="truncate text-[11px] text-muted-foreground">
                      {admin.openId}
                    </code>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  aria-label={t(`移除管理员 ${admin.openId}`, `Remove admin ${admin.openId}`)}
                  onClick={() => removeAdmin(admin.openId)}
                >
                  <Trash2 data-icon="inline-start" />
                  {t("移除", "Remove")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-3.5 py-3 text-xs text-muted-foreground leading-relaxed">
            {accessPolicy === "everyone"
              ? t(
                  "尚未指定管理员。添加后可锁定管理指令，并随时切换到「仅管理员可用」。",
                  "No admins added yet. Add yourself below to guard admin commands.",
                )
              : t(
                  "尚未添加任何管理员：当前飞书消息会被暂时拦截，你可以输入自己的 Open ID 或在下方「最近来访成员」一键授权。",
                  "No admins configured yet: incoming messages are paused until you add an Open ID or promote a recent visitor below.",
                )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={draftOpenId}
            disabled={disabled}
            placeholder="ou_xxxxxxxxxxxxxxxx"
            className="h-8 flex-[1.3] min-w-[180px] font-mono text-xs"
            onChange={(event) => {
              setDraftOpenId(event.target.value);
              setLocalError(undefined);
            }}
          />
          <Input
            value={draftName}
            disabled={disabled}
            placeholder={t("姓名备注（可选）", "Display name (optional)")}
            className="h-8 flex-1 min-w-[130px] text-xs"
            onChange={(event) => setDraftName(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (addAdmin(draftOpenId, draftName)) {
                setDraftOpenId("");
                setDraftName("");
              }
            }}
          >
            <Plus data-icon="inline-start" />
            {t("添加管理员", "Add admin")}
          </Button>
        </div>

        {localError && <p className="text-xs text-destructive">{localError}</p>}
      </div>

      {/* 3. Recent Feishu visitors */}
      {recentSenders.length > 0 && (
        <div className="grid gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-xs font-semibold text-foreground">
              {t("最近飞书来访成员", "Recent Feishu Visitors")}
            </strong>
            <span className="text-[11px] text-muted-foreground">
              {t("点击右侧按钮可直接授予或撤销管理权限", "Promote or revoke access in one click")}
            </span>
          </div>
          <div className="bot-person-list max-h-52 overflow-y-auto">
            {recentSenders.map((sender) => {
              const isAdmin = adminSet.has(sender.openId);
              return (
                <div key={sender.openId} className="bot-person-row">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span
                      className="bot-person-avatar"
                      data-role={isAdmin ? "admin" : sender.denied ? "denied" : "guest"}
                    >
                      {isAdmin ? (
                        <ShieldCheck className="size-3.5" />
                      ) : sender.denied ? (
                        <ShieldAlert className="size-3.5" />
                      ) : (
                        <Shield className="size-3.5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 grid gap-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate text-xs font-medium text-foreground">
                          {sender.name?.trim() || sender.openId}
                        </span>
                        {isAdmin ? (
                          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                            {t("管理员", "Admin")}
                          </Badge>
                        ) : sender.denied ? (
                          <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                            {t("已拦截", "Blocked")}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 min-w-0 text-[11px] text-muted-foreground">
                        <code className="truncate">{sender.openId}</code>
                        {(sender.lastChatName || sender.lastChatId) && (
                          <span className="truncate">
                            · {sender.lastChatName ?? sender.lastChatId}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {isAdmin ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={disabled}
                      onClick={() => removeAdmin(sender.openId)}
                    >
                      {t("取消授权", "Revoke")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={disabled}
                      onClick={() => addAdmin(sender.openId, sender.name ?? null)}
                    >
                      <UserCheck data-icon="inline-start" />
                      {t("设为管理员", "Make admin")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
