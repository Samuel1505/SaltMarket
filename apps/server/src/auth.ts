// Social / email login, server half (TEAM_SPLIT §1: the client shows the sign-in widget and sends us the token;
// we verify it and map the identity to a player). Provider: Privy, per docs.near.org/web3-apps/tutorials/privy
// ("the preferred way for applications that want to abstract away the wallet"). Token verification per
// docs.privy.io/authentication/user-authentication/access-tokens: ES256 JWT, iss "privy.io", aud = Privy app id,
// sub = the user's Privy DID; verification key from the Privy dashboard. Verified 2026-11-09.
import { importSPKI, jwtVerify, type CryptoKey, type KeyObject } from 'jose';

export type VerifiedIdentity = { subject: string; provider: 'privy' };

export interface SocialVerifier {
  /** Returns the verified identity, or null for any invalid, expired, or foreign token. Never throws. */
  verify(token: string): Promise<VerifiedIdentity | null>;
}

export class PrivyVerifier implements SocialVerifier {
  private key: Promise<CryptoKey | KeyObject>;
  constructor(private readonly appId: string, verificationKeyPem: string) {
    // Dashboard keys are often pasted on one line with literal "\n".
    this.key = importSPKI(verificationKeyPem.replace(/\\n/g, '\n'), 'ES256');
  }
  async verify(token: string): Promise<VerifiedIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, await this.key, { issuer: 'privy.io', audience: this.appId, algorithms: ['ES256'] });
      return typeof payload.sub === 'string' && payload.sub ? { subject: payload.sub, provider: 'privy' } : null;
    } catch {
      return null;
    }
  }
}

/** From env: PRIVY_APP_ID + PRIVY_VERIFICATION_KEY. Unset → social login is off (guest login still works). */
export function socialVerifierFromEnv(env: NodeJS.ProcessEnv): SocialVerifier | undefined {
  if (!env.PRIVY_APP_ID || !env.PRIVY_VERIFICATION_KEY) return undefined;
  return new PrivyVerifier(env.PRIVY_APP_ID, env.PRIVY_VERIFICATION_KEY);
}
