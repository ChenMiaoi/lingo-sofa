import * as React from "react";
import { useState } from "react";
import { browser } from "wxt/browser";
import { settingsSchema, type ModelConfig } from "@lingo-sofa/protocol";

/** Pricing overrides affect future direct requests; recorded costs remain intact. */
export function PricingPreferences({ model }: { model: ModelConfig }) {
  const [values, setValues] = useState(() => [
    model.prices?.input?.toString() ?? "",
    model.prices?.output?.toString() ?? "",
    model.prices?.cacheRead?.toString() ?? "",
    model.prices?.cacheWrite?.toString() ?? "",
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <details className="ls-design-card ls-billing-help">
      <summary>直连模型的自定义计价</summary>
      <p>
        当前模型：{model.model}。单位为 USD / 百万
        tokens；全部留空使用官方或目录价格。只影响后续请求的费用估算。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          const custom = values.some((value) => value.trim());
          if (
            custom &&
            values.some(
              (value) =>
                !value.trim() ||
                !Number.isFinite(Number(value)) ||
                Number(value) < 0,
            )
          ) {
            setError("请填写四个非负数，或全部留空使用默认计价。");
            return;
          }
          setBusy(true);
          void browser.runtime
            .sendMessage({ action: "state", localOnly: true })
            .then(async (current) => {
              if (current?.ok === false) throw new Error(current.error);
              if (
                current.settings.mode !== "direct" ||
                current.settings.model.provider !== model.provider ||
                current.settings.model.model !== model.model ||
                current.settings.model.endpoint !== model.endpoint ||
                current.settings.model.accountId !== model.accountId
              )
                throw new Error("当前模型已变更，请重新打开计价设置。");
              const settings = settingsSchema.parse({
                ...current.settings,
                model: {
                  ...current.settings.model,
                  prices: custom
                    ? {
                        input: Number(values[0]),
                        output: Number(values[1]),
                        cacheRead: Number(values[2]),
                        cacheWrite: Number(values[3]),
                      }
                    : null,
                },
              });
              const reply = await browser.runtime.sendMessage({
                action: "save",
                settings,
              });
              if (reply?.ok === false) throw new Error(reply.error);
              setNotice("计价已保存，将用于后续请求。");
            })
            .catch((reason: Error) => setError(reason.message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="ls-activity-toolbar">
          {["输入单价", "输出单价", "缓存读取单价", "缓存写入单价"].map(
            (label, index) => (
              <label key={label}>
                {label}
                <input
                  aria-label={label}
                  inputMode="decimal"
                  placeholder="默认"
                  value={values[index]}
                  disabled={busy}
                  onChange={(event) => {
                    setValues(
                      values.map((value, i) =>
                        i === index ? event.target.value : value,
                      ),
                    );
                    setNotice("");
                  }}
                />
              </label>
            ),
          )}
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "正在保存…" : "保存计价"}
        </button>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
    </details>
  );
}
