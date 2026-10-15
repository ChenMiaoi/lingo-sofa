import { defineConfig } from "wxt";

const icons = {
  16: "brand/icon-16.png",
  32: "brand/icon-32.png",
  48: "brand/icon-48.png",
  128: "brand/icon-128.png",
};

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    // Chrome rejects Unicode noncharacters in injected files; KaTeX uses U+FFFF.
    build: {
      rolldownOptions: { output: { minify: { codegen: { asciiOnly: true } } } },
    },
    plugins: [
      {
        name: "lingo-sofa-zod-csp",
        // Zod 4.6.7's runtime parser works in MV3; remove its optional JIT probe
        // and compiler so the shipped package contains no dynamic code generation.
        transform(code, id) {
          const path = id.replaceAll("\\", "/").split("?")[0];
          if (path?.endsWith("/zod/v4/core/util.js")) {
            const probe = /const F = Function;\s*new F\(""\);\s*return true;/;
            if (!probe.test(code))
              throw new Error(
                "Zod CSP probe changed; review the pinned-version adapter",
              );
            return { code: code.replace(probe, "return false;"), map: null };
          }
          if (path?.endsWith("/zod/v4/core/doc.js")) {
            const compiler =
              /compile\(\) \{[\s\S]*?return factory\(\.\.\.Object\.values\(this\.closed\)\);\s*\}/;
            if (!compiler.test(code))
              throw new Error(
                "Zod JIT compiler changed; review the pinned-version adapter",
              );
            return {
              code: code.replace(
                compiler,
                'compile() { throw new Error("JIT compilation is unavailable in MV3"); }',
              ),
              map: null,
            };
          }
        },
      },
    ],
  }),
  manifest: {
    name: "LingoSofa",
    description: "就地双语翻译与 Pi 助手",
    icons,
    action: { default_icon: icons },
    permissions: ["storage", "activeTab", "scripting", "nativeMessaging"],
    web_accessible_resources: [
      {
        resources: ["brand/figma/*.svg"],
        matches: ["http://*/*", "https://*/*"],
      },
    ],
    optional_host_permissions: ["https://*/*", "http://*/*"],
  },
});
