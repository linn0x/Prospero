import { useId } from "react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLocale } from "./locale";
import type { AccountApiProtocol, ModelCapabilityDraft } from "./account-profile-form";

export function ModelCapabilitiesFields({ value, onChange, disabled, protocol }: {
  value: ModelCapabilityDraft;
  onChange: (value: ModelCapabilityDraft) => void;
  disabled: boolean;
  protocol: AccountApiProtocol;
}) {
  const { t } = useLocale();
  const id = useId();
  return <details>
    <summary className="cursor-pointer">{t("模型能力（可选）", "Model capabilities (optional)")}</summary>
    <FieldGroup className="mt-3 gap-3">
      <FieldDescription>{t("按服务商文档填写。留空或未知不代表已验证。", "Use the provider's documented limits. Empty or unknown values are unverified.")}</FieldDescription>
      {protocol === "openai_chat_completions" && <FieldDescription>{t("Chat Completions 的两个 Token 上限须同时填写或同时留空。", "Chat Completions requires both token limits or neither.")}</FieldDescription>}
      {(["contextWindow", "maxOutputTokens"] as const).map((key) => <Field key={key}>
        <FieldLabel htmlFor={`${id}-${key}`}>{key === "contextWindow" ? t("上下文窗口（Tokens）", "Context window (tokens)") : t("最大输出（Tokens）", "Maximum output (tokens)")}</FieldLabel>
        <Input id={`${id}-${key}`} type="text" inputMode="numeric" pattern="[0-9]*" value={value[key]} disabled={disabled} placeholder={t("未知", "Unknown")} onChange={(event) => onChange({ ...value, [key]: event.target.value })} />
      </Field>)}
      {(["tools", "vision", "reasoning"] as const).map((key) => <Field key={key}>
        <FieldLabel htmlFor={`${id}-${key}`}>{key === "tools" ? t("工具调用", "Tool calls") : key === "vision" ? t("图片输入", "Image input") : t("推理", "Reasoning")}</FieldLabel>
        <NativeSelect id={`${id}-${key}`} value={value[key]} disabled={disabled} onChange={(event) => onChange({ ...value, [key]: event.target.value as ModelCapabilityDraft[typeof key] })}>
          <NativeSelectOption value="unknown">{t("未知", "Unknown")}</NativeSelectOption><NativeSelectOption value="true">{t("支持", "Supported")}</NativeSelectOption><NativeSelectOption value="false">{t("不支持", "Unsupported")}</NativeSelectOption>
        </NativeSelect>
      </Field>)}
      {value.tools === "false" && <FieldDescription>{t("Agent 需要工具调用；此设置将停用会话启动。", "Agents require tool calls; this setting disables session launch.")}</FieldDescription>}
    </FieldGroup>
  </details>;
}
