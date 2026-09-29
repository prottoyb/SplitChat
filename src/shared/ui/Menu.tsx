import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styles from './ui.module.css'

export type MenuItem =
  | { key: string; label: ReactNode; to: string }
  | { key: string; label: ReactNode; onClick: () => void; disabled?: boolean }

/**
 * A small disclosure menu (menu button pattern): the trigger opens a list of
 * links or actions. Enter, Space or ArrowDown opens it on the first item,
 * ArrowUp on the last; arrows, Home and End move; Escape closes and returns
 * focus to the trigger; Tab or a click outside closes it.
 */
export function Menu({
  label,
  trigger,
  items,
  triggerClassName,
}: {
  /** Accessible name of the trigger, e.g. "Group options". */
  label: string
  trigger: ReactNode
  items: MenuItem[]
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [initial, setInitial] = useState<'first' | 'last'>('first')
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const entries = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]

  useEffect(() => {
    if (!open) return
    const all = entries()
    ;(initial === 'last' ? all.at(-1) : all[0])?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, initial])

  const openAt = (where: 'first' | 'last') => {
    setInitial(where)
    setOpen(true)
  }

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(event.key === 'ArrowUp' ? 'last' : 'first')
    }
  }

  const onListKey = (event: KeyboardEvent) => {
    const all = entries()
    const index = all.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => {
      event.preventDefault()
      all[(to + all.length) % all.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(all.length - 1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div className={styles.menu} ref={root}>
      <button
        ref={button}
        type="button"
        className={triggerClassName ?? styles.menuTrigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onTriggerKey}
      >
        {trigger}
      </button>
      {open && (
        <ul id={id} role="menu" aria-label={label} className={styles.menuList} ref={list} onKeyDown={onListKey}>
          {items.map((item) => (
            <li key={item.key} role="none">
              {'to' in item ? (
                <Link role="menuitem" tabIndex={-1} to={item.to} className={styles.menuItem} onClick={() => setOpen(false)}>
                  {item.label}
                </Link>
              ) : (
                <button
                  role="menuitem"
                  type="button"
                  tabIndex={-1}
                  className={styles.menuItem}
                  aria-disabled={item.disabled || undefined}
                  onClick={() => {
                    if (item.disabled) return
                    close(true)
                    item.onClick()
                  }}
                >
                  {item.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
