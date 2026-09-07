import { useEffect, useRef, useState } from "react";
import { Copy, Link2, MonitorSmartphone, Plus, Trash2 } from "lucide-react";
import type { DesktopSnapshot, DeviceInfo } from "../../shared/types";
import { displayError } from "./state";
import { useLocale } from "./locale";

function deviceRenderKey(device: DeviceInfo, index: number): string {
  return device.id || `${device.name}:${String(index)}`;
}


export function DevicesPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { language, t } = useLocale();
  const [name, setName] = useState(() => t("我的手机", "My phone"));
  const [allowShell, setAllowShell] = useState(true);
  const [allowOrchestration, setAllowOrchestration] = useState(true);
  const [pair, setPair] = useState<{ output: string; uri?: string; qr?: string }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pairBusy, setPairBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState<string>();
  const pairBusyRef = useRef(false);
  const copyBusyRef = useRef(false);
  const revokeBusyRef = useRef(false);
  const pairResultRef = useRef<HTMLDivElement>(null);
  const deviceNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pair?.uri) pairResultRef.current?.focus();
  }, [pair?.uri]);
  const createPair = async (): Promise<void> => {
    if (pairBusyRef.current || !name.trim()) return;
    pairBusyRef.current = true;
    setPairBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { default: QRCode } = await import("qrcode");
      const result = await window.prospero.pairDevice({ name: name.trim(), allowShell, allowOrchestration });
      if (!result.uri) throw new Error(result.output || t("未生成有效的配对串", "No valid pairing code was generated"));
      try {
        const qr = await QRCode.toDataURL(result.uri, { width: 280, margin: 1, color: { dark: "#111318", light: "#ffffff" } });
        setPair({ ...result, qr });
        setNotice(t("配对二维码已生成", "Pairing QR code generated"));
      } catch (reason) {
        setPair(result);
        setError(t(`二维码生成失败，仍可复制配对串：${displayError(reason)}`, `QR code generation failed. You can still copy the pairing code: ${displayError(reason)}`));
      }
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      pairBusyRef.current = false;
      setPairBusy(false);
    }
  };
  const copyPair = async (): Promise<void> => {
    if (!pair?.uri || copyBusyRef.current) return;
    copyBusyRef.current = true;
    setCopyBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.writeClipboard(pair.uri);
      if (!result.ok) throw new Error(t("复制失败", "Copy failed"));
      setNotice(t("配对串已复制", "Pairing code copied"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      copyBusyRef.current = false;
      setCopyBusy(false);
    }
  };
  const revoke = async (device: DeviceInfo, key: string): Promise<void> => {
    if (revokeBusyRef.current) return;
    revokeBusyRef.current = true;
    setRevokeBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.revokeDevice(device.id, device.name);
      if (result.cancelled) return;
      if (!result.ok) throw new Error(result.output || t("撤销设备失败", "Unable to revoke device"));
      setNotice(t(`已撤销设备“${device.name}”`, `Revoked “${device.name}”`));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      revokeBusyRef.current = false;
      setRevokeBusy(undefined);
    }
  };
  return (
    <div className="page devices-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">{t("远程控制", "REMOTE CONTROL")}</span>
          <h1>{t("移动端", "Mobile")}</h1>
          <p>{t("配对手机，查看会话、回复问题并管理这台电脑上的 Agent。", "Pair a phone to inspect sessions, answer questions and manage agents on this computer.")}</p>
        </div>
      </header>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="security-note" role="status" aria-live="polite">{notice}</p>}
      <div className="split-management">
        <section aria-labelledby="paired-devices-title">
          <h2 id="paired-devices-title" className="section-title">
            <MonitorSmartphone size={16} aria-hidden="true" />
            {t("已配对设备", "Paired devices")}
            <span>{snapshot.devices.length}</span>
          </h2>
          <div className="device-list" role={snapshot.devices.length > 0 ? "list" : undefined}>
            {snapshot.devices.map((device, index) => {
              const key = deviceRenderKey(device, index);
              return (
                <article className="device-card" key={key} role="listitem">
                  <div className="device-icon" aria-hidden="true"><MonitorSmartphone size={20} /></div>
                  <div>
                    <strong title={device.name}>{device.name}</strong>
                    <p>
                      {device.bound ? t("已绑定", "Paired") : t("等待首次连接", "Awaiting first connection")} · {device.lastSeenAt
                        ? new Date(device.lastSeenAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
                        : t("从未连接", "Never connected")}
                    </p>
                    <div className="tag-row">
                      <span className="pill">{device.allowShell ? "Shell" : t("只读", "Read only")}</span>
                      {device.allowOrchestration && <span className="pill">{t("编排", "Orchestration")}</span>}
                    </div>
                  </div>
                  <button
                    className="icon-button danger"
                    title={t(`撤销 ${device.name}`, `Revoke ${device.name}`)}
                    aria-label={t(`撤销设备 ${device.name}`, `Revoke device ${device.name}`)}
                    aria-busy={revokeBusy === key}
                    disabled={revokeBusy !== undefined}
                    onClick={() => void revoke(device, key)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </article>
              );
            })}
            {snapshot.devices.length === 0 && (
              <div className="small-empty" role="status">
                {t("还没有已配对设备。", "No devices are paired yet.")}
              </div>
            )}
          </div>
        </section>
        <section className="form-card self-start" aria-labelledby="pair-phone-title" aria-busy={pairBusy}>
          <h2 id="pair-phone-title" className="section-title">
            <Link2 size={16} aria-hidden="true" />
            {t("让其他设备连接本机", "Pair a device with this computer")}
          </h2>
          {pair?.uri ? (
            <div
              ref={pairResultRef}
              className="pair-result"
              role="region"
              aria-label={t("新设备配对信息", "New device pairing information")}
              tabIndex={-1}
            >
              {pair.qr ? (
                <img src={pair.qr} alt={t("配对二维码", "Pairing QR code")} />
              ) : (
                <div className="small-empty" role="status">
                  {t("二维码暂不可用，请复制配对串手动输入。", "The QR code is unavailable. Copy the pairing code and enter it manually.")}
                </div>
              )}
              <p>{t("配对内容含访问凭据，请勿截图或转发。", "The pairing data contains access credentials. Do not share it.")}</p>
              <button aria-busy={copyBusy} disabled={copyBusy} onClick={() => void copyPair()}>
                <Copy size={14} aria-hidden="true" />
                {copyBusy ? t("复制中", "Copying") : t("复制配对串", "Copy pairing code")}
              </button>
              <button
                disabled={copyBusy}
                onClick={() => {
                  setPair(undefined);
                  setError(undefined);
                  setNotice(undefined);
                  window.requestAnimationFrame(() => deviceNameRef.current?.focus());
                }}
              >
                {t("返回", "Back")}
              </button>
            </div>
          ) : (
            <>
              <label htmlFor="pair-device-name">{t("设备名称", "Device name")}</label>
              <input
                ref={deviceNameRef}
                id="pair-device-name"
                maxLength={80}
                value={name}
                disabled={pairBusy}
                onChange={(event) => setName(event.target.value)}
              />
              <label className="check-row" htmlFor="pair-allow-shell">
                <input
                  id="pair-allow-shell"
                  type="checkbox"
                  checked={allowShell}
                  disabled={pairBusy}
                  onChange={(event) => {
                    setAllowShell(event.target.checked);
                    if (!event.target.checked) setAllowOrchestration(false);
                  }}
                />
                {t("允许 Shell / Agent 会话", "Allow Shell / Agent sessions")}
              </label>
              <label className="check-row" htmlFor="pair-allow-orchestration">
                <input
                  id="pair-allow-orchestration"
                  type="checkbox"
                  checked={allowOrchestration}
                  disabled={!allowShell || pairBusy}
                  onChange={(event) => setAllowOrchestration(event.target.checked)}
                />
                {t("允许创建任务与派发 worker", "Allow task creation and worker dispatch")}
              </label>
              <button className="primary" aria-busy={pairBusy} disabled={pairBusy || !name.trim()} onClick={() => void createPair()}>
                <Plus size={14} aria-hidden="true" />
                {pairBusy ? t("正在生成", "Generating") : t("生成二维码", "Generate QR code")}
              </button>
            </>
          )}
        </section>
      </div>

    </div>
  );
}

export function LogsPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busyRef = useRef(false);
  const clear = async (): Promise<void> => {
    if (busyRef.current || !snapshot.logs) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.clearLogs();
      if (result.cancelled) return;
      if (!result.ok) throw new Error(t("日志未能清空", "Logs could not be cleared"));
      setNotice(t("诊断日志已清空", "Diagnostic logs cleared"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <div className="page logs-page"><header className="page-header"><div><span className="eyebrow">{t("结构化日志", "STRUCTURED LOGS")}</span><h1>{t("诊断", "Diagnostics")}</h1><p>{t("按需检查 daemon、relay 与 terminal 日志；敏感令牌会在写入前遮盖。", "Inspect daemon, relay, and terminal logs when needed. Sensitive tokens are redacted before writing.")}</p>{error && <div className="inline-error" role="alert">{error}</div>}{notice && <p className="security-note" role="status" aria-live="polite">{notice}</p>}</div><button aria-busy={busy} disabled={busy || !snapshot.logs} onClick={() => void clear()}><Trash2 size={14} aria-hidden="true" />{busy ? t("清空中", "Clearing") : t("清空", "Clear")}</button></header><pre className="log-view">{snapshot.logs || t("暂无日志。启动 daemon 后，运行信息会出现在这里。", "No logs yet. Runtime details will appear here after the daemon starts.")}</pre></div>;
}
