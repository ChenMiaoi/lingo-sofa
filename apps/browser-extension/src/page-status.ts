export interface PageStatus {
  supported: boolean;
  hostname?: string;
  hasSelection?: boolean;
  translated?: boolean;
  pending?: boolean;
  readingEnabled?: boolean;
}
export function pageStatusLabel(status: PageStatus | undefined): string {
  if (!status) return "正在检查当前页面…";
  if (!status.supported) return "当前页面不支持翻译";
  if (status.readingEnabled === false) return "双语阅读已关闭";
  if (status.pending) return "正在翻译";
  if (status.translated) return "已显示译文";
  if (status.hasSelection) return "已选中文字";
  return status.hasSelection === false
    ? "可翻译当前页面"
    : "点击操作后检查网页访问权限";
}
