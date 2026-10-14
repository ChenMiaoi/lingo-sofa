// Scoped to plugin content; Discord theme tokens keep custom panels readable in every host theme.
export const pluginStyles = `
.lingo-sofa-panel, .lingo-sofa-accessory {
  color: var(--text-normal, #e6e6eb);
  font: 14px/1.6 var(--font-primary, system-ui);
  overflow-wrap: anywhere;
}
.lingo-sofa-panel { padding: 20px; }
.lingo-sofa-ask { max-height: 72vh; overflow-y: auto; }
.lingo-sofa-panel h2, .lingo-sofa-panel h3 { color: var(--header-primary, #fff); font-weight: 650; margin: 4px 0 16px; }
.lingo-sofa-panel h3:not(:first-child) { border-top: 1px solid var(--background-modifier-accent, #45454f); padding-top: 20px; margin-top: 24px; }
.lingo-sofa-panel p { margin: 12px 0; }
.lingo-sofa-panel label { display: block; margin: 14px 0; color: var(--text-normal, #e6e6eb); }
.lingo-sofa-panel input, .lingo-sofa-panel textarea {
  box-sizing: border-box; display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
  border: 1px solid var(--background-modifier-accent, #45454f); border-radius: 8px;
  background: var(--input-background, #22232b); color: var(--text-normal, #e6e6eb); font: inherit;
}
.lingo-sofa-panel textarea { min-height: 80px; resize: vertical; }
.lingo-sofa-panel textarea[readonly] { color: var(--text-muted, #b0b0bc); }
.lingo-sofa-panel button, .lingo-sofa-accessory button {
  font: inherit; cursor: pointer; padding: 7px 12px; margin: 4px 6px 4px 0;
  border: 1px solid var(--background-modifier-accent, #45454f); border-radius: 7px;
  color: var(--text-normal, #e6e6eb); background: var(--background-secondary, #2b2d35);
}
.lingo-sofa-panel button:hover:not(:disabled), .lingo-sofa-accessory button:hover:not(:disabled) { background: var(--background-modifier-hover, #3d3f48); }
.lingo-sofa-panel button.lingo-sofa-primary { background: var(--brand-500, #5865f2); color: white; border-color: transparent; }
.lingo-sofa-panel button:disabled, .lingo-sofa-accessory button:disabled { opacity: .5; cursor: not-allowed; }
.lingo-sofa-panel :focus-visible, .lingo-sofa-accessory :focus-visible { outline: 3px solid var(--brand-400, #8c95ff); outline-offset: 3px; }
.lingo-sofa-panel [role=alert] { color: var(--text-danger, #ffb3ae); }
.lingo-sofa-panel details { padding: 12px 0; border-top: 1px solid var(--background-modifier-accent, #45454f); }
.lingo-sofa-panel summary { cursor: pointer; }
.lingo-sofa-turn { border-left: 3px solid var(--brand-500, #5865f2); background: var(--background-secondary, #2b2d35); border-radius: 0 8px 8px 0; padding: 4px 14px; margin: 16px 0; }
.lingo-sofa-accessory { position: relative; margin: 4px 0; font: inherit; color: var(--text-normal, inherit); }
.lingo-sofa-accessory > p { margin: 4px 0; opacity: .9; }
.lingo-sofa-translation-actions { position: absolute; right: 0; top: 0; background: var(--background-secondary, #2b2d35); border-radius: 6px; z-index: 1; }
.lingo-sofa-translation-actions:not([open]) { background: transparent; }
.lingo-sofa-translation-actions summary { opacity: 0; cursor: pointer; padding: 0 5px; }
.lingo-sofa-accessory:hover summary, .lingo-sofa-accessory:focus-within summary { opacity: 1; }
.lingo-sofa-dock { position: fixed; z-index: 100; color: var(--text-normal); }
.lingo-sofa-launcher { width: 44px; height: 44px; border-radius: 15px; background: var(--background-secondary, #2b2d35); border: 1px solid var(--background-modifier-accent, #45454f); font-size: 22px; color: var(--text-normal); cursor: pointer; touch-action: none; }
.lingo-sofa-channel-panel { position: absolute; width: 290px; max-width: calc(100vw - 32px); border-radius: 12px; border: 1px solid var(--background-modifier-accent, #45454f); background: var(--background-secondary, #2b2d35); box-shadow: 0 8px 28px #0003; max-height: calc(100vh - 80px); overflow: auto; }
.lingo-sofa-control-heading { display: flex; justify-content: space-between; align-items: center; }
.lingo-sofa-control-heading button { border: 0; background: transparent; }
.lingo-sofa-channel-panel select { display: block; width: 100%; margin-top: 6px; padding: 8px; border: 1px solid var(--background-modifier-accent, #45454f); border-radius: 6px; background: var(--input-background, #22232b); color: var(--text-normal); font: inherit; }
.lingo-sofa-channel-panel input[type=checkbox] { display: inline-block; width: auto; margin: 0 8px 0 0; }
.lingo-sofa-control-hint { font-size: 12px; color: var(--text-muted); }
@media (hover: none) { .lingo-sofa-translation-actions summary { opacity: 1; } }
.lingo-sofa-accessory button { font-size: 12px; padding: 4px 8px; }
`;
