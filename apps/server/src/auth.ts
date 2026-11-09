// Social / email login, server half (TEAM_SPLIT §1: the client shows the sign-in widget and sends us the token;
// we verify it and map the identity to a player). Provider: Privy, per docs.near.org/web3-apps/tutorials/privy
// ("the preferred way for applications that want to abstract away the wallet"). Token verification per
// docs.privy.io/authentication/user-authentication/access-tokens: ES256 JWT, iss "privy.io", aud = Privy app id,
// sub = the user's Privy DID; verification key from the Privy dashboard. Verified 2026-11-09.
import { PrivyClient } from '@privy-io/node';
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
      const { payload } = await jwtVerify(token, await this.key, { issuer: 'privy.io', audience: this.appId, algorithms: ['ES256'], typ: 'JWT' });
      return typeof payload.sub === 'string' && payload.sub ? { subject: payload.sub, provider: 'privy' } : null;
    } catch {
      return null;
    }
  }
}

/**
 * The same check through Privy's official server SDK (@privy-io/node 0.38.0), for when the dashboard shows only the
 * App ID and App secret: the SDK fetches the app's verification key itself (from {api}/v1/apps/{appId}/jwks.json,
 * authenticated with the app credentials) and checks an ES256 token (header typ "JWT") for the app. Verified from the
 * package source: `new PrivyClient({ appId, appSecret, jwtVerificationKey? })`,
 * `client.utils().auth().verifyAccessToken(token: string)` → `{ app_id, user_id, issuer, issued_at, expiration,
 * session_id }`, throws on an invalid token.
 */
export class PrivySdkVerifier implements SocialVerifier {
  private readonly client: PrivyClient;
  constructor(private readonly appId: string, appSecret: string, jwtVerificationKey?: string) {
    this.client = new PrivyClient({ appId, appSecret, ...(jwtVerificationKey ? { jwtVerificationKey: jwtVerificationKey.replace(/\\n/g, '\n') } : {}) });
  }
  async verify(token: string): Promise<VerifiedIdentity | null> {
    try {
      const r = await this.client.utils().auth().verifyAccessToken(token);
      if (r.app_id !== this.appId || r.issuer !== 'privy.io' || !r.user_id) return null;
      return { subject: r.user_id, provider: 'privy' };
    } catch {
      return null;
    }
  }
}

/**
 * From env (never logged):
 *  - PRIVY_APP_ID + PRIVY_VERIFICATION_KEY → verify locally (no call to Privy).
 *  - PRIVY_APP_ID + PRIVY_APP_SECRET      → Privy's SDK fetches the key (use when the dashboard shows no key).
 * Neither → social login is off (guest login still works).
 */
export function socialVerifierFromEnv(env: NodeJS.ProcessEnv): { verifier: SocialVerifier; mode: string } | undefined {
  if (!env.PRIVY_APP_ID) return undefined;
  if (env.PRIVY_VERIFICATION_KEY) return { verifier: new PrivyVerifier(env.PRIVY_APP_ID, env.PRIVY_VERIFICATION_KEY), mode: 'Privy (verification key)' };
  if (env.PRIVY_APP_SECRET) return { verifier: new PrivySdkVerifier(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET), mode: 'Privy (app secret, SDK)' };
  return undefined;
}
