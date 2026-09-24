import { useState } from 'react';
import { Button } from '@oremedia/ui';
import { hasCredential, signOut } from '../../lib/session';
import { useSessionUser } from './use-session-user';

/** Header controls for the signed-in person: who is signed in, and Sign out (D-03). */
export function SessionControls() {
  const signedIn = hasCredential();
  const user = useSessionUser(signedIn);
  const [busy, setBusy] = useState(false);
  if (!signedIn) return null;
  return (
    <>
      {user.data && (
        <span className="max-w-48 truncate text-sm text-muted-foreground" title={user.data.email}>
          <span className="sr-only">Signed in as </span>
          {user.data.name}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signOut();
        }}
      >
        Sign out
      </Button>
    </>
  );
}
