import { toast } from 'sonner';
import type { ClientMessage } from '@saltmarket/shared/protocol';
import { send, type Ack } from './game';

/**
 * Send a player action and show the server's message as a toast (success or failure).
 * Trades render from the delta that follows, never optimistically.
 */
export async function act(m: ClientMessage, opts: { quiet?: boolean } = {}): Promise<Ack> {
  const ack = await send(m);
  if (!opts.quiet || !ack.ok) {
    if (ack.ok) toast(ack.message, { id: ack.cmdId });
    else toast.error(ack.message, { id: ack.cmdId });
  }
  return ack;
}
