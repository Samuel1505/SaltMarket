import { useState, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { Reasoning, ReasonFactor } from '@saltmarket/shared/protocol';
import { formatMarks } from '@saltmarket/shared/client';
import { hold } from '../styles/tokens.motion';

/**
 * The reasoning tooltip (track requirement R9). Opens on hover (after a short delay), on tap/click, and on
 * keyboard focus. A Popover, not a Tooltip, because a tooltip doesn't open on tap.
 * Focus stays on the trigger so moving through the board with Tab stays fast.
 */
export function ReasonPopover({ trigger, label, children }: { trigger: ReactNode; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        openOnHover
        delay={hold.tooltipDelay}
        className="reason-trigger"
        aria-label={label}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) setOpen(true);
        }}
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} collisionPadding={16}>
          <Popover.Popup className="popup" initialFocus={false} finalFocus={false}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function factorText(f: ReasonFactor): string {
  const v = f.value;
  if (typeof v === 'string') return `${f.label}: ${v}`;
  switch (f.unit) {
    case 'pips':
      return `${f.label}: ${formatMarks(v)} marks`;
    case 'pct':
      return `${f.label}: ${v}%`;
    case 'count':
      return f.of !== undefined ? `${f.label}: ${v} of ${f.of}` : `${f.label}: ${v}`;
    case 'ticks':
      return `${f.label}: ${v} h`;
    default:
      return `${f.label}: ${v}`;
  }
}

/** Reason text (bold) + detail (muted) + factor chips. */
export function ReasonBody({ reason, who }: { reason: Reasoning; who?: string }) {
  return (
    <div>
      <p className="popup-title">
        {who && <span className="muted">{who}: </span>}
        {reason.text}
      </p>
      {reason.detail && <p className="popup-detail">{reason.detail}</p>}
      {reason.factors.length > 0 && (
        <div className="factors">
          {reason.factors.map((f) => (
            <span key={f.key} className="factor">
              {factorText(f)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
