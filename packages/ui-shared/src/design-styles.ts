import { themeStyles } from "./theme.js";
/** Shared product foundations; colors follow the current unified theme. */
export const designStyles =
  themeStyles(
    ".ls-intelligence,.ls-product-settings,.ls-ask,.ls-provider-page,.ls-settings,.ls-ask-model,.lingo-sofa-auth",
  ) +
  `
.ls-intelligence,.ls-product-settings,.ls-ask{
color:var(--ls-text);font:14px/1.6 Inter,"Noto Sans SC",system-ui,sans-serif}
.ls-intelligence *,.ls-product-settings *,.ls-ask *{box-sizing:border-box}
.ls-intelligence{display:flex;flex-direction:column;gap:14px;min-width:0}
.ls-design-heading{margin:0 0 0;padding:0}.ls-design-heading .ls-overline,.ls-overline{color:var(--ls-accent);opacity:1;font:600 11px/17px Inter,system-ui,sans-serif;letter-spacing:0}
.ls-design-heading h1{font-size:28px;line-height:42px;font-weight:700;letter-spacing:0;margin:14px 0}
.ls-design-heading p{font-size:14px;line-height:20px;margin:0 0 0;color:var(--ls-muted)}
.ls-design-card{padding:20px;border:1px solid var(--ls-border);border-radius:14px;background:var(--ls-surface);min-width:0}
.ls-design-card h2{font-size:15px;line-height:23px;font-weight:700;letter-spacing:0;margin:0 0 14px}
.ls-design-card strong,.ls-advanced strong{font-size:14px;line-height:21px;font-weight:500}
.ls-design-card small,.ls-advanced small{display:block;font-size:12px;line-height:18px;color:var(--ls-muted);margin-top:3px}
.ls-intelligence button,.ls-product-settings button,.ls-provider-page button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--ls-border);border-radius:8px;background:var(--ls-surface);padding:10px 16px;min-height:40px;margin:0}
.ls-intelligence :is(button,select):disabled{cursor:not-allowed;opacity:.5}
.ls-intelligence :focus-visible,.ls-product-settings :focus-visible,.ls-ask :focus-visible{outline:2px solid var(--ls-accent);outline-offset:2px}
.ls-status-chip{padding:5px 10px;white-space:nowrap;border-radius:999px;background:var(--ls-tint);color:var(--ls-accent);font-size:12px;line-height:17px}
.ls-setting-row{display:flex;justify-content:space-between;align-items:center;gap:24px;min-height:42px}.ls-setting-row+.ls-setting-row{border-top:1px solid var(--ls-border);padding-top:14px;margin-top:14px}.ls-setting-row>div{min-width:0;flex:1}
.ls-setting-row select{width:240px;flex-shrink:0;min-height:40px;border:1px solid var(--ls-border);border-radius:8px;padding:9px 12px;background:var(--ls-surface);color:var(--ls-text);font:inherit;font-size:14px;line-height:20px;margin:0;max-width:100%;text-overflow:ellipsis}
.ls-readonly-value{font-size:14px;line-height:22px;color:var(--ls-muted);max-width:45%;text-align:right;overflow-wrap:anywhere}
.ls-capability-details summary{cursor:pointer;font-weight:500;color:var(--ls-muted)}.ls-capability-details[open] summary{margin-bottom:16px}
.ls-intelligence .ls-row-title{min-height:0;border:0;padding:0;background:transparent;font-size:14px;line-height:21px;font-weight:500;text-align:left}
.ls-engine-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.ls-engine-heading h2{margin:0}.ls-engine-intro{color:var(--ls-muted);font-size:12px;line-height:1.7;margin:10px 0 16px}
.ls-engine-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px}.ls-intelligence .ls-engine-choices button{display:flex;align-items:center;gap:10px;text-align:left;padding:14px 12px;min-width:0;background:var(--ls-subtle);border-color:transparent}.ls-engine-choices button[aria-pressed=true]{border-color:var(--ls-accent);background:var(--ls-tint)}.ls-engine-choices strong{font-size:14px}.ls-engine-choices small{font-size:12px}.ls-engine-icon{font:600 20px/1.2 system-ui;color:var(--ls-accent);flex-shrink:0}.ls-engine-check{margin-left:auto;color:var(--ls-accent)}.ls-engine-note{color:var(--ls-muted);font-size:12px;line-height:1.7;margin:0 0 12px}.ls-intelligence .ls-engine-configure{background:transparent;border:0;color:var(--ls-accent);font-size:12px;min-height:30px;padding:4px 0;margin-top:10px}
@media(max-width:800px){.ls-engine-choices{grid-template-columns:1fr}.ls-engine-choices button>span:nth-child(2){display:flex;align-items:baseline;gap:10px}}
.ls-intelligence .ls-advanced{display:flex;align-items:flex-start;gap:12px;background:var(--ls-subtle);border:0;border-radius:10px;padding:16px;text-align:left}.ls-advanced>span:first-child{font-size:18px;color:var(--ls-muted)}
.ls-design-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:12px;line-height:17px;color:var(--ls-muted)}
.ls-intelligence .ls-design-footer button{border:0;background:transparent;color:var(--ls-accent);font-size:12px;padding:0;min-height:24px}
.ls-provider-page{width:100%;padding:0;color:var(--ls-text)}

.ls-provider-page .ls-settings{--ls-surface:inherit;--ls-accent:inherit;display:block;border:0;border-radius:0;min-height:0;background:transparent;font-size:14px;--ls-line:var(--ls-border);--ls-soft:var(--ls-subtle)}
.ls-provider-page .ls-settings-nav{flex-direction:row;padding:12px 0;gap:4px;border-right:0;border-bottom:1px solid var(--ls-border);background:transparent}
.ls-provider-page .ls-settings-nav>.ls-overline,.ls-provider-page .ls-settings-nav>p,.ls-provider-page .ls-settings-nav button>span{display:none}
.ls-provider-page .ls-settings-nav button{font-size:12px;justify-content:center;padding:10px 6px!important;white-space:nowrap}.ls-provider-page .ls-settings-nav button[aria-current=page]{background:var(--ls-tint)!important;box-shadow:none;color:var(--ls-accent)}
.ls-provider-page .ls-settings-content{padding:20px 0 0}.ls-provider-page .ls-section-header{display:none}.ls-provider-page .ls-accounts{grid-template-columns:1fr}.ls-provider-page .ls-settings-footer{flex-wrap:wrap;gap:12px;margin-top:20px}.ls-provider-page .ls-settings-footer>span{max-width:100%}.ls-provider-page .ls-dialog-done{display:block;margin:20px 0 0 auto;background:var(--ls-accent);color:var(--ls-on-accent);border:0}
@media(max-width:700px){.ls-setting-row{gap:10px;align-items:stretch;flex-direction:column}.ls-setting-row select{width:100%}.ls-readonly-value{max-width:100%;text-align:left}.ls-provider-page{padding:20px}.ls-design-heading h1{font-size:25px}}
`;
