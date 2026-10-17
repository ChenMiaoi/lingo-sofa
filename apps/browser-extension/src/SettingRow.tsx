import type { ReactNode } from "react";
export const settingRow = (
  title: string,
  description: string,
  control: ReactNode,
) => (
  <div className="ls-setting-row" key={title}>
    <div>
      <strong>{title}</strong>
      <small>{description}</small>
    </div>
    {control}
  </div>
);
