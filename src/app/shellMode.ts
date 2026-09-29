/**
 * Phones (D1, Phase 9): a compact top bar and a bottom tab bar. Group chat
 * hides both so the conversation gets the screen; full-page forms hide the
 * tab bar so their actions stay in reach.
 */
export function shellMode(pathname: string): '' | ' app-shell--chat' | ' app-shell--form' {
  if (/^\/groups\/[^/]+\/chat\/?$/.test(pathname)) return ' app-shell--chat'
  if (/^\/(groups\/[^/]+\/(expenses\/new|proposals\/[^/]+\/edit)|expenses\/[^/]+\/edit)\/?$/.test(pathname)) return ' app-shell--form'
  return ''
}
