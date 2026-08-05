export const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** A small hover button that never lets its click reach the row underneath. */
export function actionButton(label: string, title: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const button = el('button', 'act', label)
  button.title = title
  button.addEventListener('click', event => {
    event.stopPropagation()
    void onClick()
  })
  return button
}
