import * as React from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '@oremedia/ui';

/**
 * A side sheet on the Radix Dialog primitive (as dialog.tsx): focus is trapped and returned, Escape and the overlay
 * close it, the title is the accessible name. Used for the brand navigation at phone width and for side sheets
 * (asset detail and upload, the brand analyst).
 */
export const Drawer = RadixDialog.Root;
export const DrawerTrigger = RadixDialog.Trigger;

export function DrawerContent({
  title,
  side = 'left',
  className,
  children,
}: {
  title: string;
  side?: 'left' | 'right';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 bg-foreground/40" />
      <RadixDialog.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-[min(85vw,18rem)] flex-col border-border bg-background text-foreground shadow-lg outline-none',
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
          className,
        )}
      >
        <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
        <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
