'use client';

import { type KeyboardEvent, type ReactNode, useRef } from 'react';

type Variant = 'underline' | 'segmented';

const TAB: Record<Variant, { list: string; tab: (on: boolean) => string }> = {
  underline: {
    list: 'flex gap-1 border-b border-rule',
    tab: (on) =>
      `-mb-px border-b-2 px-3 pt-1 pb-2.5 text-[13.5px] font-medium transition-colors ${
        on ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink'
      }`,
  },
  segmented: {
    list: 'inline-flex rounded-lg bg-rule-2 p-1',
    tab: (on) =>
      `rounded-md px-3.5 py-1.5 text-[13px] font-medium ${
        on ? 'bg-sheet text-ink shadow-[0_1px_2px_rgba(22,33,58,0.08)]' : 'text-ink-2'
      }`,
  },
};

/**
 * A tab list as the ARIA pattern describes it: one tab in the tab order, arrow keys and Home/End
 * move between tabs and select them, each tab names the panel it controls.
 */
export function Tabs<K extends string>({
  id,
  tabs,
  value,
  onChange,
  variant = 'underline',
  label,
  marks,
  className = '',
}: {
  /** Prefix for tab and panel ids; unique on the page. */
  id: string;
  tabs: readonly (readonly [K, string])[];
  value: K;
  onChange: (key: K) => void;
  variant?: Variant;
  label: string;
  /** Something small after a tab's name, such as an overdue dot. */
  marks?: Partial<Record<K, ReactNode>>;
  className?: string;
}) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const keys = tabs.map(([k]) => k);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = keys.indexOf(value);
    const next =
      e.key === 'ArrowRight'
        ? keys[(at + 1) % keys.length]
        : e.key === 'ArrowLeft'
          ? keys[(at - 1 + keys.length) % keys.length]
          : e.key === 'Home'
            ? keys[0]
            : e.key === 'End'
              ? keys[keys.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className={`${TAB[variant].list} ${className}`}>
      {tabs.map(([key, name]) => {
        const on = key === value;
        return (
          <button
            key={key}
            ref={(el) => {
              if (el) refs.current.set(key, el);
              else refs.current.delete(key);
            }}
            id={`${id}-tab-${key}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`${id}-panel-${key}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(key)}
            onKeyDown={onKeyDown}
            className={TAB[variant].tab(on)}
          >
            {name}
            {marks?.[key]}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  tab,
  children,
  className = '',
}: {
  id: string;
  tab: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={`${id}-panel-${tab}`}
      aria-labelledby={`${id}-tab-${tab}`}
      className={className}
    >
      {children}
    </div>
  );
}
