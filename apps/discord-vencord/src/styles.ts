import { themeStyles, themeAliases } from "@lingo-sofa/ui-shared";
// Scoped to plugin content; Discord theme tokens keep custom panels readable in every host theme.
export const pluginStyles =
  themeStyles(".lingo-sofa-panel,.lingo-sofa-accessory,.lingo-sofa-dock") +
  `
.lingo-sofa-panel,.lingo-sofa-accessory,.lingo-sofa-dock{${themeAliases}}
.lingo-sofa-panel, .lingo-sofa-accessory {
  color: var(--lingo-text);
  font: 14px/1.6 var(--font-primary, system-ui);
  overflow-wrap: anywhere;
}
.lingo-sofa-panel { padding: 20px; }
.lingo-sofa-panel h2, .lingo-sofa-panel h3 { color: var(--text-strong, var(--header-primary, var(--lingo-text))); font-weight: 650; margin: 4px 0 16px; }
.lingo-sofa-panel h3:not(:first-child) { border-top: 1px solid var(--lingo-border); padding-top: 20px; margin-top: 24px; }
.lingo-sofa-panel p { margin: 12px 0; }
.lingo-sofa-panel label { display: block; margin: 14px 0; color: var(--lingo-text); }
.lingo-sofa-panel input, .lingo-sofa-panel textarea {
  box-sizing: border-box; display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
  border: 1px solid var(--lingo-border); border-radius: 8px;
  background: var(--lingo-surface); color: var(--lingo-text); font: inherit;
}
.lingo-sofa-panel textarea { min-height: 80px; resize: vertical; }
.lingo-sofa-panel textarea[readonly] { color: var(--text-muted, var(--lingo-text)); }
.lingo-sofa-panel button, .lingo-sofa-accessory button {
  font: inherit; cursor: pointer; padding: 7px 12px; margin: 4px 6px 4px 0;
  border: 1px solid var(--lingo-border); border-radius: 7px;
  color: var(--lingo-text); background: var(--lingo-surface);
}
.lingo-sofa-panel button:hover:not(:disabled), .lingo-sofa-accessory button:hover:not(:disabled) { background: var(--ls-subtle); }
.lingo-sofa-panel button.lingo-sofa-primary { background: var(--ls-accent); color: var(--ls-on-accent); border-color: transparent; }
.lingo-sofa-panel button:disabled, .lingo-sofa-accessory button:disabled { opacity: .5; cursor: not-allowed; }
.lingo-sofa-panel :focus-visible, .lingo-sofa-accessory :focus-visible { outline: 3px solid var(--ls-accent); outline-offset: 3px; }
.lingo-sofa-panel [role=alert] { color: var(--text-feedback-critical, var(--text-danger, var(--lingo-text))); }
.lingo-sofa-panel details { padding: 12px 0; border-top: 1px solid var(--lingo-border); }
.lingo-sofa-panel summary { cursor: pointer; }
.lingo-sofa-turn { border-left: 3px solid var(--ls-accent); background: var(--lingo-surface); border-radius: 0 8px 8px 0; padding: 4px 14px; margin: 16px 0; }
.lingo-sofa-accessory { position: relative; margin: 6px 0; padding-block-start: 6px; border-block-start: 1px solid var(--lingo-border); font: inherit; line-height: 1.5; color: var(--lingo-text); }
.lingo-sofa-inline-usage { margin-top: 6px; font-size: 12px; font-weight: 400; line-height: 1.5; color: var(--text-muted, var(--lingo-text)); }
.lingo-sofa-accessory > p { margin: 4px 0; color: inherit; opacity: 1; }
.lingo-sofa-translation-actions { position: absolute; right: 0; top: 0; background: var(--lingo-surface); border-radius: 6px; z-index: 1; }
.lingo-sofa-translation-actions:not([open]) { background: transparent; }
.lingo-sofa-translation-actions summary { opacity: 0; cursor: pointer; padding: 0 5px; }
.lingo-sofa-accessory:hover summary, .lingo-sofa-accessory:focus-within summary { opacity: 1; }
.lingo-sofa-dock { position: fixed; z-index: 100; color: var(--lingo-text); }
.lingo-sofa-launcher { width: 44px; height: 44px; border-radius: 15px; background: var(--lingo-surface); border: 1px solid var(--lingo-border); font-size: 22px; color: var(--lingo-text); cursor: pointer; touch-action: none; }
.lingo-sofa-channel-panel { box-sizing: border-box; position: absolute; width: 320px; padding: 18px; max-width: calc(100vw - 32px); border-radius: 12px; border: 1px solid var(--lingo-border); background: var(--lingo-surface); box-shadow: 0 8px 28px #0003; max-height: calc(100vh - 80px); overflow: auto; }
.lingo-sofa-control-heading { display: flex; justify-content: space-between; align-items: center; }
.lingo-sofa-control-heading button { border: 0; background: transparent; }
.lingo-sofa-control-heading { gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--lingo-border); }
.lingo-sofa-control-heading > div { min-width: 0; }
.lingo-sofa-control-heading strong { display: block; font-size: 16px; line-height: 1.4; }
.lingo-sofa-channel-name { display: block; color: var(--text-muted, var(--lingo-text)); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lingo-sofa-control-heading button { flex-shrink: 0; width: 30px; height: 30px; padding: 0; margin: 0; font-size: 22px; }
.lingo-sofa-reading-options { padding: 4px 0 14px; }
.lingo-sofa-field-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.lingo-sofa-field-heading > span { color: var(--text-muted, var(--lingo-text)); font-size: 12px; font-weight: 400; }
.lingo-sofa-channel-panel .lingo-sofa-reading-options label { font-size: 13px; font-weight: 600; margin: 14px 0 0; }
.lingo-sofa-channel-panel .lingo-sofa-reading-options select { box-sizing: border-box; min-height: 40px; padding: 8px 10px; border-radius: 8px; font-size: 14px; font-weight: 400; }
.lingo-sofa-channel-panel .lingo-sofa-auto-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid var(--lingo-border); margin: 0; padding-top: 14px; }
.lingo-sofa-auto-row > span > strong, .lingo-sofa-auto-row .lingo-sofa-control-hint { display: block; }
.lingo-sofa-auto-row strong { font-size: 14px; font-weight: 600; }
.lingo-sofa-channel-panel .lingo-sofa-auto-row input { appearance: none; display: block; width: 38px; height: 22px; padding: 2px; margin: 0; border-radius: 20px; background: var(--background-modifier-accent, GrayText); flex-shrink: 0; cursor: pointer; }
.lingo-sofa-auto-row input::before { content: ""; display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--ls-toggle-knob); transition: transform .15s ease; }
.lingo-sofa-channel-panel .lingo-sofa-auto-row input:checked { background: var(--ls-accent); border-color: transparent; }
.lingo-sofa-auto-row input:checked::before { background:var(--ls-on-accent);transform: translateX(16px); }
.lingo-sofa-auto-row input:disabled { opacity: .5; cursor: wait; }
.lingo-sofa-channel-panel .lingo-sofa-control-status { margin: 12px 0 0; font-size: 12px; color: var(--text-muted, var(--lingo-text)); }
@media (prefers-reduced-motion: reduce) { .lingo-sofa-auto-row input::before { transition: none; } }

.lingo-sofa-channel-panel select { display: block; width: 100%; margin-top: 6px; padding: 8px; border: 1px solid var(--lingo-border); border-radius: 6px; background: var(--lingo-surface); color: var(--lingo-text); font: inherit; }
.lingo-sofa-channel-panel input[type=checkbox] { display: inline-block; width: auto; margin: 0 8px 0 0; }
.lingo-sofa-control-hint { font-size: 12px; color: var(--text-muted, var(--lingo-text)); }
.lingo-sofa-provider { max-width: 1040px; margin: 0 auto; padding: 0; }
@media (hover: none) { .lingo-sofa-translation-actions summary { opacity: 1; } }
.lingo-sofa-accessory button { font-size: 12px; padding: 4px 8px; }
`;
