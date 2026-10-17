import type {
  TranslationEngine,
  TranslationEngineClient,
} from "@lingo-sofa/protocol";
import { proseTemplate } from "./prose.js";

export const webTranslationOrigins = {
  bing: "https://edge.microsoft.com/*",
  google: "https://translate.googleapis.com/*",
} as const;
const languageNames: Record<string, string> = {
  简体中文: "zh-CN",
  中文: "zh-CN",
  "Chinese (Simplified)": "zh-CN",
  繁體中文: "zh-TW",
  繁体中文: "zh-TW",
  "Chinese (Traditional)": "zh-TW",
  English: "en",
  日本語: "ja",
  한국어: "ko",
  Français: "fr",
  Deutsch: "de",
  Español: "es",
  Português: "pt",
  Italiano: "it",
  Русский: "ru",
  العربية: "ar",
  हिन्दी: "hi",
  ไทย: "th",
  "Tiếng Việt": "vi",
  "Bahasa Indonesia": "id",
};
export function translationLanguage(value: string, engine: "bing" | "google") {
  let code = languageNames[value] ?? value;
  if (!/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})?$/u.test(code))
    throw new Error("此翻译引擎需要语言代码或列表中的目标语言");
  if (/^zh(?:-(?:CN|Hans))?$/iu.test(code))
    code = engine === "bing" ? "zh-Hans" : "zh-CN";
  else if (/^zh-(?:TW|HK|Hant)$/iu.test(code))
    code = engine === "bing" ? "zh-Hant" : "zh-TW";
  return code;
}

/** Network is supplied by the host; no keys, browser APIs, or Node dependencies. */
export function createWebTranslator(
  engine: Exclude<TranslationEngine, "llm">,
  network: typeof fetch,
): TranslationEngineClient {
  const name = engine === "bing" ? "必应" : "谷歌";
  async function request(
    texts: string[],
    language: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const url =
      engine === "bing"
        ? `https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=${encodeURIComponent(language)}`
        : `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(language)}&dt=t`;
    const response = await network(url, {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type":
          engine === "bing"
            ? "application/json"
            : "application/x-www-form-urlencoded",
      },
      body:
        engine === "bing"
          ? JSON.stringify(texts)
          : new URLSearchParams({ q: texts[0]! }).toString(),
    });
    if (!response.ok)
      throw new Error(
        `${name}翻译暂不可用（${response.status}），请稍后重试或手动切换引擎`,
      );
    const data: unknown = await response.json();
    const results: unknown[] =
      engine === "bing"
        ? Array.isArray(data)
          ? data.map((item) => item?.translations?.[0]?.text)
          : []
        : Array.isArray(data) &&
            Array.isArray(data[0]) &&
            data[0].every(
              (part: unknown) =>
                Array.isArray(part) && typeof part[0] === "string",
            )
          ? [
              data[0]
                .map((part: unknown) =>
                  Array.isArray(part) && typeof part[0] === "string"
                    ? part[0]
                    : "",
                )
                .join(""),
            ]
          : [];
    if (
      results.length !== texts.length ||
      results.some(
        (text) =>
          typeof text !== "string" || !text.trim() || text.length > 32_000,
      )
    )
      throw new Error(`${name}翻译返回了无效结果，请稍后重试或手动切换引擎`);
    return results as string[];
  }
  return {
    async translate(units, terms, signal) {
      const started = Date.now();
      const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const results = [];
      try {
        for (const unit of units) {
          combined.throwIfAborted();
          const language = translationLanguage(unit.targetLanguage, engine);
          const template = proseTemplate(unit.text, unit.protectedParts, terms);
          const translated: string[] = [];
          for (let index = 0; index < template.texts.length;) {
            const batch: string[] = [];
            let length = 0;
            while (
              index < template.texts.length &&
              batch.length < (engine === "bing" ? 16 : 1)
            ) {
              const text = template.texts[index]!;
              if (batch.length && length + text.length > 4000) break;
              batch.push(text);
              length += text.length;
              index++;
            }
            translated.push(...(await request(batch, language, combined)));
          }
          results.push({
            id: unit.id,
            revision: unit.revision,
            text: template.combine(translated),
          });
        }
        combined.throwIfAborted();
        return {
          results,
          metrics: {
            billingMode: "free",
            characters: units.reduce(
              (sum, unit) => sum + Array.from(unit.text).length,
              0,
            ),
            usage: null,
            costKnown: true,
            durationMs: Date.now() - started,
            firstOutputMs: null,
            firstTextMs: null,
            generationMs: null,
            tps: null,
          },
        };
      } catch (reason) {
        signal.throwIfAborted();
        if (reason instanceof Error && /翻译|语言/u.test(reason.message))
          throw reason;
        throw new Error(`${name}翻译连接失败或超时，请稍后重试或手动切换引擎`, {
          cause: reason,
        });
      }
    },
  };
}
