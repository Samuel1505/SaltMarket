import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '@saltmarket/chain';
import { LoginResponse } from '@saltmarket/shared/protocol';
import { buildApp } from './app.js';
import { PrivyVerifier } from './auth.js';
import { SimBackend } from './live/simBackend.js';

const APP = 'test-privy-app';
async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const pem = await exportSPKI(publicKey);
  const sign = (sub: string, o: { aud?: string; iss?: string; exp?: string } = {}) =>
    new SignJWT({ sid: 's1' }).setProtectedHeader({ alg: 'ES256' }).setIssuer(o.iss ?? 'privy.io').setAudience(o.aud ?? APP).setSubject(sub).setIssuedAt().setExpirationTime(o.exp ?? '1h').sign(privateKey);
  return { verifier: new PrivyVerifier(APP, pem.replace(/\n/g, '\\n')), sign };
}

describe('social login (Privy access token, server side)', () => {
  it('verifies issuer, audience, signature and expiry', async () => {
    const { verifier, sign } = await setup();
    expect(await verifier.verify(await sign('did:privy:abc'))).toEqual({ subject: 'did:privy:abc', provider: 'privy' });
    expect(await verifier.verify(await sign('did:privy:abc', { aud: 'other-app' }))).toBeNull();
    expect(await verifier.verify(await sign('did:privy:abc', { iss: 'evil.io' }))).toBeNull();
    expect(await verifier.verify(await sign('did:privy:abc', { exp: '-1m' }))).toBeNull();
    const other = await setup();
    expect(await verifier.verify(await other.sign('did:privy:abc'))).toBeNull(); // wrong key
    expect(await verifier.verify('not-a-jwt')).toBeNull();
  });

  it('same identity → same player, also after a restart; bad tokens are refused', async () => {
    const { verifier, sign } = await setup();
    const path = join(mkdtempSync(join(tmpdir(), 'saltmarket-auth-')), 'world.json');
    const b1 = new SimBackend({ seed: 1, ledger: new MemoryLedger(), social: verifier, snapshotPath: path });
    const { app } = await buildApp(b1, { judge: false, autoTick: false, validateOutgoing: 'throw' });
    const login = async (credential?: string, a = app) => LoginResponse.parse((await a.inject({ method: 'POST', url: '/api/auth/login', payload: { provider: 'social', displayName: 'Mira', ...(credential ? { credential } : {}) } })).json());
    const first = await login(await sign('did:privy:mira'));
    const again = await login(await sign('did:privy:mira'));
    if (!first.ok || !again.ok) throw new Error('login failed');
    expect(again.data.playerId).toBe(first.data.playerId);
    expect(again.data.provider).toBe('social');
    expect(await login(await sign('did:privy:mira', { aud: 'x' }))).toMatchObject({ ok: false, code: 'BAD_CREDENTIAL' });
    expect(await login()).toMatchObject({ ok: false, code: 'BAD_CREDENTIAL' });
    b1.saveSnapshot();
    await app.close();
    const b2 = new SimBackend({ seed: 1, ledger: new MemoryLedger(), social: verifier, snapshotPath: path });
    const r = await b2.loginSocial(await sign('did:privy:mira'));
    expect(r.ok && r.data.playerId).toBe(first.data.playerId);
  });

  it('without Privy configured, social login says so and guest still works', async () => {
    const b = new SimBackend({ seed: 1, ledger: new MemoryLedger() });
    expect(await b.loginSocial('anything')).toMatchObject({ ok: false, code: 'SOCIAL_UNAVAILABLE' });
    expect(b.login('guest').ok).toBe(true);
  });
});
