/** Codex footer structure is stable even when the model display name changes. */
export const CODEX_FOOTER_RE = /^[ \t]*([^\s›»❯•·│┃║][^·\r\n]{0,119}?)(?:[ \t]+(?:minimal|low|medium|high|xhigh|max|ultra|none))?[ \t]*[·•][ \t]*(?:\d+(?:\.\d+)?%[ \t]+(?:context[ \t]+)?left[ \t]*[·•][ \t]*)?(?:~\/|\/|\.{1,2}\/)[^\s·]+[ \t]*(?:[·•][^·•\r\n]{0,240}){0,8}$/i;

export const CODEX_HINT_LINE_RE = /^(?:[ \t]*← for agents[ \t]*[·•][ \t]*)?\?[ \t]+for shortcuts\b|^[ \t]*⚠[ \t]*\d+[ \t]+warnings?[ \t]*[·•][ \t]*f2 to view\b|^[ \t]*\d+(?:\.\d+)?%[ \t]+(?:context[ \t]+)?left\b/i;
