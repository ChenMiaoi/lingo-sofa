import { useEffect, useState } from "react";
import type { ProviderAccount } from "@lingo-sofa/protocol";
import { sendSettingsMessage } from "./settings-message.js";

export function AccountMigration({
  full = false,
  onMigrated,
}: {
  full?: boolean;
  onMigrated?: () => void;
}) {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void sendSettingsMessage({ action: "account-migration-status" })
      .then((reply: { accounts: ProviderAccount[] }) => {
        if (active) setAccounts(reply.accounts);
      })
      .catch(() => {
        if (active) setError("无法读取旧浏览器账户，请重新打开设置页后重试。");
      });
    return () => {
      active = false;
    };
  }, []);
  if (!accounts.length && !error && !notice) return null;
  return (
    <section className="ls-design-card" aria-label="浏览器账户迁移">
      {accounts.length > 0 && (
        <>
          <h2>将旧浏览器账户迁移为共享账户</h2>
          <p>发现 {accounts.length} 个旧账户，当前不会用于模型请求。</p>
          {full ? (
            <>
              <ul>
                {accounts.map((account) => (
                  <li key={account.id}>
                    {account.name} · {new URL(account.model.endpoint).host}
                  </li>
                ))}
              </ul>
              <p>
                迁移会保留助手已有账户，并将浏览器的翻译和 Ask
                模型设为共享默认值。成功后浏览器不再保存
                Key；失败时保留原配置供重试。
              </p>
              <button
                className="ls-solid-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void sendSettingsMessage({ action: "account-migrate" })
                    .then(() => {
                      setAccounts([]);
                      setNotice("账户已迁移，浏览器与 Discord 现已共用。");
                      onMigrated?.();
                    })
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "迁移未完成，原账户已保留",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "正在迁移…" : "迁移浏览器账户并共用"}
              </button>
            </>
          ) : (
            <a href="#connection">前往连接页面迁移 →</a>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
