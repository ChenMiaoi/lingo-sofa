export interface AssistantAsset {
  url: string;
  sha256: string;
  directory: string;
}
export interface AssistantRelease {
  version: string;
  assets: Record<string, AssistantAsset>;
}
export const assistantDownloads =
  "https://github.com/ChenMiaoi/lingo-sofa/releases";
export function validateAsset(
  release: AssistantRelease,
  platform: string,
  arch: string,
): AssistantAsset {
  const key = `${platform}-${arch}`;
  const asset = release.assets[key];
  const directory = `lingo-sofa-assistant-${release.version}-${key}`;
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !asset ||
    asset.directory !== directory ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    asset.url !==
      `${assistantDownloads}/download/v${release.version}/${directory}.tar.gz`
  )
    throw new Error(
      "此平台尚无已固定校验值的助手安装包，请在发布页查看可用版本",
    );
  return asset;
}
