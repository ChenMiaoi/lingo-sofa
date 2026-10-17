import { designStyles } from "./design-styles.js";
export const aiWorkspaceStyles =
  designStyles +
  `
.ls-settings,.ls-ask-model{--ls-line:color-mix(in srgb,currentColor 13%,transparent);--ls-soft:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:14px/1.55 var(--font-primary,system-ui,sans-serif)}
.ls-settings *,.ls-ask-model *{box-sizing:border-box}
.ls-settings{display:grid;grid-template-columns:208px minmax(0,1fr);border:1px solid var(--ls-line);border-radius:16px;background:var(--ls-surface);overflow:hidden;min-height:590px}
.ls-settings-nav{padding:28px 16px;background:var(--ls-soft);border-right:1px solid var(--ls-line);display:flex;flex-direction:column;gap:6px}
.ls-overline{font-size:10px;letter-spacing:1.6px;font-weight:650;opacity:.55;display:block}
.ls-settings-nav>.ls-overline{padding:0 12px;margin-bottom:18px}
.ls-settings-nav button{border:0!important;display:flex;align-items:center;gap:12px;width:100%;text-align:left;margin:0!important;padding:11px 12px!important;border-radius:8px!important;background:transparent!important;color:inherit;font:inherit;cursor:pointer}
.ls-settings-nav button>span{width:20px;font-size:16px;text-align:center;opacity:.7}
.ls-settings-nav button[aria-current=page]{background:var(--ls-surface)!important;box-shadow:0 1px 4px #00000009;color:var(--ls-accent);font-weight:600}
.ls-settings-nav>p{font-size:11px!important;opacity:.5;line-height:1.8;margin:auto 12px 0!important;padding-top:48px}
.ls-settings-content{padding:34px 40px;min-width:0}
.ls-section-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:30px}
.ls-section-header h2{font-size:23px!important;letter-spacing:-.6px;margin:6px 0 8px!important;line-height:1.4}
.ls-section-header p{font-size:13px!important;opacity:.6;margin:0!important}
.ls-connection{border:1px solid var(--ls-line);border-radius:20px;padding:3px 9px;font-size:10px;white-space:nowrap;opacity:.65;margin-top:3px}
.ls-preferences-card{max-width:660px;min-width:0;border:0;padding:0;margin:0}
.ls-settings .model-preferences,.ls-ask-model .model-preferences{display:grid;grid-template-columns:1fr 1fr;gap:20px 16px;border:0;padding:0;margin:0;min-width:0}
.ls-settings .model-preferences legend,.ls-ask-model .model-preferences legend{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}
.ls-settings .model-preferences>label:first-of-type,.ls-settings .model-preferences>label:has(input[type=search]),.ls-ask-model .model-preferences>label:first-of-type,.ls-ask-model .model-preferences>label:has(input[type=search]){grid-column:1/-1}
.ls-settings label,.ls-ask-model label{display:block;font-size:12px;font-weight:550;margin:0 0 18px;min-width:0}
.ls-settings .model-preferences label,.ls-ask-model .model-preferences label{margin:0}
.ls-settings input,.ls-settings select,.ls-ask-model input,.ls-ask-model select{display:block;width:100%;max-width:100%;min-width:0;height:39px;margin:7px 0 0;padding:8px 11px;border:1px solid var(--ls-line);border-radius:7px;background:var(--ls-surface);color:inherit;font-family:inherit;font-size:13px;line-height:1.4;box-shadow:0 1px 2px #00000003}
.ls-settings select,.ls-ask-model select{font-family:inherit;font-size:12px;text-overflow:ellipsis}
.ls-settings input:focus,.ls-settings select:focus,.ls-ask-model input:focus,.ls-ask-model select:focus{outline:2px solid color-mix(in srgb,var(--ls-accent) 35%,transparent);outline-offset:1px;border-color:var(--ls-accent)}
.ls-settings input[type=search],.ls-ask-model input[type=search]{background:var(--ls-soft)}
.ls-settings small,.ls-ask-model small{font-size:11px;opacity:.6;font-weight:400;grid-column:1/-1}
.ls-settings .model-preferences{margin-bottom:24px}
.ls-field-note{float:right;font-size:10px;font-weight:400;opacity:.5}
.ls-settings-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--ls-line);padding-top:20px;margin-top:32px}
.ls-settings-footer>span{font-size:11px;opacity:.6;max-width:65%}
.ls-settings-footer>div{display:flex;gap:8px;flex-shrink:0}
.ls-settings-footer button{font-family:inherit;font-size:12px;line-height:1.4;padding:8px 14px;min-height:36px;cursor:pointer;border:1px solid var(--ls-line);border-radius:7px;color:inherit;background:transparent;margin:0}
.ls-settings-footer .primary{background:var(--ls-accent)!important;color:var(--ls-on-accent)!important;border-color:var(--ls-accent)!important}
.ls-unsaved-changes{padding:16px;border:1px solid var(--ls-line);border-radius:10px;background:var(--ls-soft);margin-bottom:20px;font-size:13px}
.ls-unsaved-changes button{margin:4px 8px 0 0;padding:8px 12px;border:1px solid var(--ls-line);border-radius:7px;background:var(--ls-surface);color:inherit;cursor:pointer;font:inherit}
.ls-settings button:disabled,.ls-ask-model :disabled{opacity:.45;cursor:not-allowed}
.ls-accounts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:28px}
.ls-accounts .ls-account{display:flex;align-items:center;gap:10px;padding:12px!important;border:1px solid var(--ls-line)!important;background:transparent!important;color:inherit;min-width:0;border-radius:9px!important;margin:0!important;cursor:pointer;text-align:left}
.ls-account>span:nth-child(2){min-width:0;flex:1}
.ls-account strong,.ls-account small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-account strong{font-size:12px}.ls-account small{font-size:10px!important}
.ls-accounts .ls-account[aria-pressed=true]{border-color:var(--ls-accent)!important;background:color-mix(in srgb,var(--ls-accent) 5%,transparent)!important}
.ls-account-icon{height:30px;width:30px;display:grid;place-items:center;border-radius:8px;background:var(--ls-soft);flex-shrink:0;font-size:12px}
.ls-accounts .ls-add-account{background:transparent!important;border:1px dashed var(--ls-line)!important;min-height:54px;color:inherit;font:12px system-ui;border-radius:9px;cursor:pointer;margin:0!important}
.ls-notification{padding:10px 12px;border:1px solid var(--ls-line);border-radius:8px;font-size:12px}
.ls-ask-model{margin:16px 0;padding:12px 0;border-top:1px solid var(--ls-line);border-bottom:1px solid var(--ls-line)}
.ls-ask-model details{border:0!important;padding:0!important}
.ls-ask-model summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;font-size:11px}
.ls-ask-model summary strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}
.ls-ask-model summary>span{margin-left:auto;font-size:10px;opacity:.6;white-space:nowrap}
.ls-ask-model small{display:block;margin-top:8px;font-size:10px;line-height:1.6}
.ls-ask-model details[open]>.model-preferences{margin-top:18px;margin-bottom:12px}
.ls-connected-account{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--ls-soft);border:1px solid var(--ls-line);border-radius:8px;padding:12px;font-size:11px}.ls-connected-account small{display:block;overflow-wrap:anywhere;margin-top:3px}.ls-connected-account button{border:0;background:transparent;white-space:nowrap;font-size:11px;color:inherit;cursor:pointer}
@media(max-width:700px){.ls-settings .model-preferences,.ls-ask-model .model-preferences{grid-template-columns:1fr}.ls-settings{grid-template-columns:1fr;min-height:0}.ls-settings-nav{flex-direction:row;border-right:0;border-bottom:1px solid var(--ls-line);padding:10px;gap:4px}.ls-settings-nav>.ls-overline,.ls-settings-nav>p{display:none}.ls-settings-nav button{justify-content:center;font-size:11px;gap:6px;padding:9px 6px!important}.ls-settings-nav button>span{font-size:13px;width:auto}.ls-settings-content{padding:24px 20px}.ls-section-header{margin-bottom:24px}.ls-settings-footer{align-items:flex-start;flex-direction:column;gap:12px}.ls-settings-footer>span{max-width:100%}.ls-settings-footer>div{align-self:flex-end}.ls-accounts{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){.ls-settings-nav button[aria-current=page]{color:var(--ls-accent)}}
`;
