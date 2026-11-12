import type { ClientMessage } from '@saltmarket/shared/protocol';
import { send, type Ack } from './game';
import { notify } from '../lib/notify';

/**
 * Send a player action and show the server's message as a toast (success or failure).
 * Trades render from the delta that follows, never optimistically.
 */
export async function act(m: ClientMessage, opts: { quiet?: boolean } = {}): Promise<Ack> {
  const ack = await send(m);
  if (!opts.quiet || !ack.ok) {
    notify(ack.message, { tone: ack.ok ? 'default' : 'error' });
  }
  return ack;
}
