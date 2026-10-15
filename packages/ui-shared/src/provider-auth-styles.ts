/** Shared auth card uses each host's font, foreground and accent. */
import { themeStyles } from "./theme.js";
export const providerAuthStyles =
  themeStyles(".lingo-sofa-auth") +
  `
.lingo-sofa-auth {margin-block:18px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:14px;padding:5px;color:inherit;}
.lingo-sofa-auth-modes {display:grid;grid-template-columns:1fr 1fr;gap:4px;}
.lingo-sofa-auth-modes button {margin:0;min-height:40px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer;}
.lingo-sofa-auth-modes button[aria-pressed="true"] {background:color-mix(in srgb,var(--ls-accent) 20%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ls-accent) 45%,transparent);font-weight:600;}
.lingo-sofa-auth-account {display:grid;gap:12px;padding:18px 12px 12px;min-width:0;}
.lingo-sofa-auth-account p {margin:4px 0;font-size:13px;line-height:1.6;}
.lingo-sofa-auth-account strong {font-size:15px;}
.lingo-sofa-auth-account a {color:inherit;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere;}
.lingo-sofa-auth-note,.lingo-sofa-auth-account small {opacity:.8;line-height:1.6;}
.lingo-sofa-auth-actions {display:flex;flex-wrap:wrap;gap:8px;}
.lingo-sofa-auth-actions button {font:inherit;font-size:13px;min-height:36px;padding:7px 12px;border-radius:9px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;cursor:pointer;}
.lingo-sofa-auth button:disabled {opacity:.5;cursor:default;}
.lingo-sofa-auth button:focus-visible,.lingo-sofa-auth a:focus-visible {outline:2px solid var(--ls-accent);outline-offset:3px;}
`;
