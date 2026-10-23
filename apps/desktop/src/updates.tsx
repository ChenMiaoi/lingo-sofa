import React from "react";
import type { DesktopState, UpdateSnapshot } from "./api";
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
}: {
  state: DesktopState;
  perform: Perform;
}) {
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
  const total = update.total && update.total > 0 ? update.total : undefined;
  return (
    <section className="settings-group" aria-labelledby="updates-heading">
      <h2 id="updates-heading">关于与更新</h2>
      <div className="default-model-summary">
        <span>当前版本</span>
        <strong>LingoSofa {update.currentVersion || "…"}</strong>
      </div>
      <div className="model-setting-row">
        <label>应用更新</label>
        <div className="setting-control">
          <div className="update-actions">
            <span role="status">{updateSummary(update)}</span>
            <button
              disabled={working || (update.phase === "ready" && taskActive)}
              onClick={() => void perform(action)}
            >
              {label}
            </button>
          </div>
          {update.phase === "downloading" && (
            <>
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
            </>
          )}
          {update.lastChecked !== null && (
            <p>
              上次检查：{new Date(update.lastChecked * 1000).toLocaleString()}
            </p>
          )}
          {update.error && (
            <p role="alert">{errors[update.error] ?? "更新失败，请重试。"}</p>
          )}
          {update.phase === "ready" && (
            <p>
              {taskActive
                ? "请等待当前任务结束后安装。"
                : "安装会重启应用，请先保存输入草稿。"}
            </p>
          )}
        </div>
      </div>
      <div className="model-setting-row">
        <label htmlFor="auto-update">自动检查</label>
        <div className="setting-control">
          <label className="check">
            <input
              id="auto-update"
              type="checkbox"
              checked={update.autoCheck}
              onChange={(event) =>
                void perform("set_auto_update", {
                  enabled: event.target.checked,
                })
              }
            />
            自动检查应用更新
          </label>
          <p>启动时及每 6 小时检查。</p>
        </div>
      </div>
      {update.notes && (
        <div className="update-notes">
          <h2>版本说明</h2>
          <p>{update.notes}</p>
        </div>
      )}
    </section>
  );
}
