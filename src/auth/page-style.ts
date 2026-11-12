import { createHash } from 'node:crypto';

/**
 * The one style block shared by every browser page (visual direction "Signal").
 * The Content-Security-Policy allows exactly this text by its SHA-256 hash, so the pages need no
 * 'unsafe-inline' and no nonce. Any edit changes the hash automatically. The pages must never use
 * a style= attribute (a hash-only policy blocks them), a script, or an external resource.
 */
export const PAGE_STYLE = [
    '*{box-sizing:border-box}',
    'html{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}',
    'body{margin:0;background:var(--bg);color:var(--text);font-size:16px;line-height:1.5}',
    'main{width:min(100% - 32px,600px);margin:0 auto;padding:40px 0 56px}',
    'h1,h2,p,ul{margin:0}',
    'h1{font-size:clamp(28px,5vw,38px);line-height:1.12;letter-spacing:-.035em;margin-top:22px;overflow-wrap:anywhere}',
    'h2{font-size:17px;font-weight:700;letter-spacing:-.02em}',
    'p{line-height:1.5}',
    '.brand{font:600 13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.05em;color:var(--text);border-top:6px solid var(--accent);padding-top:16px}',
    '.request{margin:24px 0;padding:16px;background:var(--panel);border-left:4px solid var(--accent);overflow-wrap:anywhere}',
    '.request strong{font-weight:700}',
    '.request small{display:block;margin-top:3px;color:var(--muted);font-size:14px}',
    '.request .host{color:var(--text);font-family:ui-monospace,monospace}',
    '.section{margin-top:26px}',
    '.section h2{margin-bottom:13px}',
    '.field{display:block;margin-top:15px;font-weight:650;font-size:15px}',
    '.field input{display:block;width:100%;height:48px;margin-top:7px;padding:10px 12px;border:1px solid var(--border);border-radius:3px;background:var(--field);color:var(--text);font:inherit;font-size:16px}',
    '.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;column-gap:16px;margin-top:4px}',
    '.row label{order:0}',
    '.row input{order:2;flex:0 0 100%;margin-top:0}',
    '.aside{order:1;padding:12px 0;color:var(--muted);font-size:14px;font-weight:500;line-height:20px;text-decoration:underline;text-underline-offset:2px}',
    '.aside:hover{color:var(--text)}',
    '.help{margin-top:8px;color:var(--muted);font-size:14px}',
    '.permissions{margin-top:28px}',
    '.permissions h2{margin-bottom:9px}',
    '.rows{border-top:1px solid var(--rule)}',
    '.permissions+.help{margin-top:14px}',
    '.rows ul{padding:0;list-style:none}',
    '.permission{display:flex;align-items:flex-start;gap:12px;min-height:48px;padding:12px 0;border-bottom:1px solid var(--rule);font-size:15px;font-weight:500}',
    '.permission input{flex:none;width:20px;height:20px;margin:2px 0 0;accent-color:var(--accent)}',
    '.permission span{display:block;min-width:0;overflow-wrap:anywhere}',
    '.permission small{display:block;color:var(--muted);font:500 13px/1.4 ui-monospace,monospace}',
    '.permission em{display:block;color:var(--sensitive);font-style:normal;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
    'li.permission::before{content:"\\2013";content:"\\2013" / "";flex:none;width:20px;text-align:center;color:var(--muted)}',
    '.privacy{margin-top:22px;color:var(--muted);font-size:14px}',
    '.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:25px}',
    'button{font:700 15px system-ui,sans-serif;min-height:48px;min-width:112px;padding:10px 22px;border:2px solid var(--button);cursor:pointer}',
    'button.primary{background:var(--button);color:var(--buttonText)}',
    'button.secondary{background:transparent;color:var(--text);border-color:var(--border)}',
    'button:hover{filter:brightness(.92)}',
    ':focus-visible{outline:3px solid var(--focus);outline-offset:3px}',
    '.terminal{margin-top:30px;padding:20px;border-left:4px solid var(--sensitive);background:var(--panel)}',
    '.terminal p{margin-top:8px}',
    '@media(max-width:420px){main{padding-top:24px}.actions button{flex:1;padding:10px 12px}.request{margin-top:20px}}',
    ':root{--bg:#fff;--panel:#f3f5f9;--text:#0b1020;--muted:#4a5468;--rule:#cdd3de;--border:#748098;--accent:#00794a;--sensitive:#963c22;--field:#fff;--button:#0b1020;--buttonText:#fff;--focus:#0b1020}',
    '@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b1020;--panel:#141b30;--text:#e8ecf5;--muted:#a3adc2;--rule:#394461;--border:#8793ad;--accent:#3ddc97;--sensitive:#ffab8f;--field:#101829;--button:#e8ecf5;--buttonText:#0b1020;--focus:#e8ecf5}}',
].join('');

/** The CSP source expression for PAGE_STYLE. */
export const PAGE_STYLE_SOURCE = `'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'`;
