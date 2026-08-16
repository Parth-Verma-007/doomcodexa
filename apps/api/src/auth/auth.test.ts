import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Account and session behaviour.
 *
 * The negative cases carry the weight. Anyone can check that a correct password
 * signs you in; what matters is that a wrong one is indistinguishable from an
 * unknown account, that a hash never reaches the wire, and that signing out
 * actually ends the session rather than only clearing the client.
 */

let app: Express;

beforeAll(async () => {
  process.env.EXEC_DISABLED = '1';
  const { createApp } = await import('../app.js');
  app = createApp();
});

const signUp = (body: Record<string, unknown>) => request(app).post('/api/auth/signup').send(body);

const logIn = (body: Record<string, unknown>) => request(app).post('/api/auth/login').send(body);

const ACCOUNT = { email: 'ada@codexa.test', username: 'ada', password: 'analytical-engine' };

describe('sign-up', () => {
  it('creates an account and returns a working session', async () => {
    const res = await signUp(ACCOUNT).expect(201);

    expect(res.body.user.username).toBe('ada');
    expect(res.body.token).toEqual(expect.any(String));

    await request(app).get('/api/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
  });

  it('never returns the password or its hash', async () => {
    const res = await signUp(ACCOUNT).expect(201);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(ACCOUNT.password);
    expect(body).not.toContain('scrypt');
    expect(body).not.toMatch(/passwordHash/i);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await signUp(ACCOUNT).expect(201);
    const res = await signUp({ ...ACCOUNT, username: 'ada2', email: 'ADA@codexa.test' }).expect(
      409,
    );

    expect(res.body.error.code).toBe('conflict');
  });

  it('rejects a duplicate username regardless of case', async () => {
    await signUp(ACCOUNT).expect(201);
    await signUp({ ...ACCOUNT, email: 'other@codexa.test', username: 'ADA' }).expect(409);
  });

  it('rejects a password that is too short', async () => {
    const res = await signUp({ ...ACCOUNT, password: 'short' }).expect(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects a malformed email', async () => {
    await signUp({ ...ACCOUNT, email: 'not-an-email' }).expect(422);
  });

  it('rejects a username with illegal characters', async () => {
    await signUp({ ...ACCOUNT, username: 'ada smith' }).expect(422);
  });
});

describe('sign-in', () => {
  it('accepts either the email or the username, in any case', async () => {
    await signUp(ACCOUNT).expect(201);

    for (const identifier of ['ada@codexa.test', 'ada', 'ADA@codexa.test', 'Ada']) {
      const res = await logIn({ identifier, password: ACCOUNT.password }).expect(200);
      expect(res.body.token).toEqual(expect.any(String));
    }
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await signUp(ACCOUNT).expect(201);

    const wrongPassword = await logIn({ identifier: 'ada', password: 'wrong' }).expect(401);
    const noSuchUser = await logIn({ identifier: 'nobody', password: 'wrong' }).expect(401);

    // Identical bodies: anything that differs is an account-existence oracle.
    // The message may name all three fields — that is what stops it singling
    // one out — but it must never say which of them was the problem.
    expect(wrongPassword.body).toEqual(noSuchUser.body);
    expect(wrongPassword.body.error.message).not.toMatch(/no such|not found|does not exist/i);
  });

  it('does not accept the password of a different account', async () => {
    await signUp(ACCOUNT).expect(201);
    await signUp({ email: 'bob@codexa.test', username: 'bob', password: 'a-different-one' }).expect(
      201,
    );

    await logIn({ identifier: 'ada', password: 'a-different-one' }).expect(401);
  });
});

describe('sessions', () => {
  it('refuses a request with no token, a malformed one, or a token that is not a session', async () => {
    await request(app).get('/api/me').expect(401);
    await request(app).get('/api/me').set('Authorization', 'Basic abc').expect(401);
    await request(app).get('/api/me').set('Authorization', 'Bearer ').expect(401);
    await request(app).get('/api/me').set('Authorization', 'Bearer made-up-token').expect(401);
  });

  it('stops accepting a token once it is signed out', async () => {
    const { body } = await signUp(ACCOUNT).expect(201);
    const auth = { Authorization: `Bearer ${body.token}` };

    await request(app).get('/api/me').set(auth).expect(200);
    await request(app).post('/api/auth/logout').set(auth).expect(204);
    await request(app).get('/api/me').set(auth).expect(401);
  });

  it('leaves other sessions alone when one signs out', async () => {
    await signUp(ACCOUNT).expect(201);

    const phone = await logIn({ identifier: 'ada', password: ACCOUNT.password }).expect(200);
    const laptop = await logIn({ identifier: 'ada', password: ACCOUNT.password }).expect(200);
    expect(phone.body.token).not.toBe(laptop.body.token);

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${phone.body.token}`)
      .expect(204);

    await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${laptop.body.token}`)
      .expect(200);
  });

  it('signs out idempotently, even with a token that was never valid', async () => {
    await request(app).post('/api/auth/logout').set('Authorization', 'Bearer nonsense').expect(204);
    await request(app).post('/api/auth/logout').expect(204);
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const { body } = await signUp(ACCOUNT).expect(201);
    const { Session } = await import('../db/models/index.js');

    const stored = await Session.findOne({});
    expect(stored).not.toBeNull();
    expect(stored!.tokenHash).not.toBe(body.token);
    expect(stored!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('password storage', () => {
  it('stores a salted scrypt hash, not the password', async () => {
    await signUp(ACCOUNT).expect(201);
    const { User } = await import('../db/models/index.js');

    const user = await User.findOne({ username: 'ada' }).select('+passwordHash');
    expect(user!.passwordHash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(user!.passwordHash).not.toContain(ACCOUNT.password);
  });

  it('gives two accounts with the same password different hashes', async () => {
    await signUp(ACCOUNT).expect(201);
    await signUp({ email: 'b@codexa.test', username: 'bee', password: ACCOUNT.password }).expect(
      201,
    );

    const { User } = await import('../db/models/index.js');
    const [a, b] = await User.find({}).select('+passwordHash').sort({ username: 1 });

    // Distinct salts. Without them, one cracked hash cracks every account that
    // shares the password, and equal hashes reveal who shares one.
    expect(a!.passwordHash).not.toBe(b!.passwordHash);
  });

  it('refuses a stored hash that would make verification arbitrarily expensive', async () => {
    // The stored key length becomes scrypt's `keylen`. Ours is always 64, but a
    // corrupted or hostile row carrying a huge one would turn every login
    // attempt against that account into an arbitrary amount of work.
    const { verifyPassword } = await import('./password.js');
    const huge = Buffer.alloc(64 * 1024, 7).toString('base64url');

    await expect(verifyPassword('anything', `scrypt$16384$8$1$c2FsdA$${huge}`)).resolves.toBe(
      false,
    );
    // And the cost parameters themselves stay bounded.
    await expect(verifyPassword('anything', 'scrypt$999999999$8$1$c2FsdA$aGk')).resolves.toBe(
      false,
    );
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });

  it('does not expose the hash on a normal read', async () => {
    await signUp(ACCOUNT).expect(201);
    const { User } = await import('../db/models/index.js');

    const user = await User.findOne({ username: 'ada' });
    expect(user!.get('passwordHash')).toBeUndefined();
  });
});
