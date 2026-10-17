import type { ReactNode } from "react";
export const settingRow = (
  title: string,
  description: string,
  control: ReactNode,
  id?: string,
) => (
  <div className="ls-setting-row" key={title} data-setting={id}>
    <div>
      <strong>{title}</strong>
      <small>{description}</small>
    </div>
    {control}
  </div>
);
