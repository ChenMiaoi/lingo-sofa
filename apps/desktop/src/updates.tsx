import React, { useEffect, useRef, useState } from "react";
import { errorMessage, type DesktopState, type UpdateSnapshot } from "./api";
import type { Perform } from "./view";

export function updateSummary(update: UpdateSnapshot): string {
  const messages: Record<UpdateSnapshot["phase"], string> = {
    idle: "检查新版本",
    checking: "正在检查更新…",
    available: `发现新版本 ${update.availableVersion ?? ""}`,
    downloading: "正在下载更新…",
    ready: "更新已就绪",
    installing: "正在安装更新…",
    "up-to-date": "已是最新版本",
    "no-release": "尚未发布可用更新",
    error: "检查更新失败",
  };
  return messages[update.phase];
}
export function UpdateSettings({
  state,
  perform,
  notice = "",
}: {
  state: DesktopState;
  perform: Perform;
  notice?: string;
}) {
  const [pendingAction, setPendingAction] = useState("");
  const actionPending = useRef(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const autoPending = useRef(false);
  const [actionError, setActionError] = useState("");
  const [autoError, setAutoError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const update = state.updates;
  const working = ["checking", "downloading", "installing"].includes(
    update.phase,
  );
  const taskActive = ["preparing", "running", "compacting"].includes(
    state.model.phase,
  );
  const errors: Record<string, string> = {
    network: "无法连接更新服务，请检查网络后重试。",
    metadata: "更新信息无效或暂不支持此设备，请稍后重试。",
    download: "下载失败或签名校验未通过，请重新下载。",
    install: "安装失败，请关闭占用应用的程序后重试。",
    development: "开发构建不安装更新，请使用正式安装包。",
  };
  const action =
    update.phase === "ready"
      ? "install_update"
      : update.phase === "available"
        ? "download_update"
        : "check_updates";
  const label =
    update.phase === "ready"
      ? "安装并重启"
      : update.phase === "available"
        ? "下载更新"
        : update.phase === "downloading"
          ? "下载中…"
          : update.phase === "installing"
            ? "安装中…"
            : update.phase === "checking"
              ? "检查中…"
              : "检查更新";
  const pendingLabels: Record<string, string> = {
    check_updates: "检查中…",
    download_update: "下载中…",
    install_update: "安装中…",
  };
  const runAction = async () => {
    if (
      actionPending.current ||
      working ||
      (update.phase === "ready" && taskActive)
    )
      return;
    actionPending.current = true;
    setPendingAction(action);
    setActionError("");
    try {
      const ok = await perform(action);
      if (live.current && ok === false)
        setActionError("更新操作未完成，请重试。");
    } catch (reason) {
      if (live.current) setActionError(errorMessage(reason));
    } finally {
      actionPending.current = false;
      if (live.current) setPendingAction("");
    }
  };
  const saveAuto = async (enabled: boolean) => {
    if (autoPending.current) return;
    autoPending.current = true;
    setSavingAuto(true);
    setAutoError("");
    try {
      const ok = await perform("set_auto_update", { enabled });
      if (live.current && ok === false)
        setAutoError("设置保存失败，原配置继续生效。");
    } catch (reason) {
      if (live.current) setAutoError(errorMessage(reason));
    } finally {
      autoPending.current = false;
      if (live.current) setSavingAuto(false);
    }
  };
  const total = update.total && update.total > 0 ? update.total : undefined;
  return (
    <section className="settings-group updates-group" aria-label="关于与更新">
      <div className="update-version">
        <span>当前版本</span>
        <strong>LingoSofa {update.currentVersion || "…"}</strong>
      </div>
      <div className="update-actions">
        <span role="status">
          {pendingAction && !working
            ? pendingLabels[pendingAction]
            : updateSummary(update)}
        </span>
        <button
          disabled={
            !!pendingAction ||
            working ||
            (update.phase === "ready" && taskActive)
          }
          onClick={() => void runAction()}
        >
          {pendingAction ? pendingLabels[pendingAction] : label}
        </button>
      </div>
      {update.phase === "downloading" && (
        <div className="update-download">
          <progress
            aria-label="更新下载进度"
            value={total ? Math.min(update.downloaded, total) : undefined}
            max={total}
          />
          <p>
            {(update.downloaded / 1024 / 1024).toFixed(1)} MB
            {total
              ? ` / ${(total / 1024 / 1024).toFixed(1)} MB`
              : " · 正在接收"}
          </p>
        </div>
      )}
      {update.lastChecked !== null && (
        <p className="update-checked">
          上次检查：{new Date(update.lastChecked * 1000).toLocaleString()}
        </p>
      )}
      {update.error && (
        <p className="update-error" role="alert">
          {errors[update.error] ?? "更新失败，请重试。"}
        </p>
      )}
      {!notice && !update.error && actionError && (
        <p className="update-error" role="alert">
          {actionError}
        </p>
      )}
      {update.phase === "ready" && (
        <p className="update-restart">
          {taskActive
            ? "请等待当前任务结束后安装。"
            : "安装会重启应用，请先保存输入草稿。"}
        </p>
      )}
      <div className="preference-row preference-toggle update-preference">
        <div className="preference-copy">
          <label htmlFor="auto-update">自动检查更新</label>
          <p id="auto-update-help">启动时及每 6 小时检查。</p>
          {savingAuto && (
            <p id="auto-update-saving" role="status">
              自动检查保存中…
            </p>
          )}
          {!notice && autoError && (
            <p className="update-error" role="alert">
              {autoError}
            </p>
          )}
        </div>
        <input
          id="auto-update"
          type="checkbox"
          checked={update.autoCheck}
          disabled={savingAuto}
          aria-describedby={`auto-update-help${savingAuto ? " auto-update-saving" : ""}`}
          onChange={(event) => void saveAuto(event.target.checked)}
        />
      </div>
      {update.notes && (
        <div className="update-notes">
          <h3>版本说明</h3>
          <p>{update.notes}</p>
        </div>
      )}
    </section>
  );
}
