import { defineConfig } from "wxt";
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "LingoSofa",
    description: "就地双语翻译与 Pi 助手",
    permissions: ["storage", "activeTab", "scripting", "nativeMessaging"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
  },
});
