import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useLocale } from "../locale";
import { reportError } from "../state";

interface AccountCreateFormProps {
  disabled: boolean;
  busy?: "managed-create" | undefined;
  error?: string | undefined;
  onCreateManaged: (input: { agent: "codex" | "claude"; name: string }) => Promise<boolean>;
}

export function AccountCreateForm({ disabled, busy, error, onCreateManaged }: AccountCreateFormProps) {
  const { t } = useLocale();
  const id = useId();
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [name, setName] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  const inactive = disabled || Boolean(busy) || submitting;
  const message = localError ?? error;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (message) errorRef.current?.focus(); }, [message]);
  const submit = async () => {
    if (pending.current || inactive) return;
    pending.current = true;
    setSubmitting(true); setLocalError(undefined);
    try {
      if (name.trim() && await onCreateManaged({ agent, name: name.trim() }) && mounted.current) setName("");
    } catch (reason) { if (mounted.current) setLocalError(reportError(reason)); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
  return <section className="account-create-form" aria-label={t("添加订阅账号", "Add subscription account")} aria-busy={inactive}>
    <form id={`${id}-cli-panel`} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={inactive}>
        <Field><FieldLabel htmlFor={`${id}-agent`}>{t("订阅平台 (CLI Agent)", "CLI agent")}</FieldLabel><NativeSelect id={`${id}-agent`} value={agent} onChange={event => setAgent(event.target.value as "codex" | "claude")}><NativeSelectOption value="codex">Codex (ChatGPT Plus / Pro / Team)</NativeSelectOption><NativeSelectOption value="claude">Claude (Claude Pro / Max / Team)</NativeSelectOption></NativeSelect></Field>
        <Field><FieldLabel htmlFor={`${id}-name`}>{t("备注名称", "Display name")}</FieldLabel><Input id={`${id}-name`} value={name} maxLength={80} required placeholder={t("例如：主力 Pro / 备用号 #2", "Work account")} onChange={event => setName(event.target.value)} /></Field>
        <FieldDescription>{t("创建独立隔离的登录目录后，将自动打开官方 CLI 登录终端。", "Create an isolated account and open the official CLI sign-in terminal.")}</FieldDescription>
      </fieldset>
      {message && <div ref={errorRef} className="account-inline-error" role="alert" tabIndex={-1}>{message}</div>}
      <Button type="submit" disabled={inactive || !name.trim()}>
        {(busy || submitting) && <Spinner />}{busy || submitting ? t("处理中…", "Working…") : t("创建并登录", "Create and sign in")}
      </Button>
    </form>
  </section>;
}
