/**
 * The plugin's stylesheets, installed once.
 *
 * The panel renders them through its provider, but the chat groups tab lives in
 * the right sidebar and renders without that provider, so both surfaces share one
 * document-level tag installed when the client plugin applies.
 */
import CHAT_CSS from './chat.css?raw'
import OFFICIAL_CSS from './official.css?raw'
import SHELL_CSS from './shell.css?raw'
import VENDOR_CSS from './panel/vendor/client/client.css?raw'

const TAG = 'superagent-remote/styles'

/** Add the stylesheet tags, once per document. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@gamegeek-saikel/dsh-superagent-remote'
  tag.dataset.pluginCss = TAG
  tag.textContent = VENDOR_CSS + '\n' + SHELL_CSS + '\n' + CHAT_CSS + '\n' + OFFICIAL_CSS
  document.head.appendChild(tag)
}
