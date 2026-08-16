/**
 * Wipe the local database and seed it with real accounts.
 *
 * Deliberately goes through the HTTP API rather than writing documents
 * directly: the accounts it creates are then indistinguishable from ones a
 * person signed up for, hashes and all. Writing users straight into Mongo is
 * how a seed script comes to produce accounts that cannot actually sign in.
 *
 *   node scripts/seed.mjs [--api http://localhost:4000] [--keep]
 *
 * `--keep` skips the wipe and only creates whatever is missing.
 *
 * Passwords come from the environment, never from this file. A checked-in
 * credential is a credential published to everyone who can read the repository,
 * and seed accounts have a way of outliving the laptop they were seeded on:
 *
 *   SEED_PASSWORD_PARTH=… SEED_PASSWORD_JOEL=… node scripts/seed.mjs
 *
 * Anything left unset gets a generated password, printed once at the end.
 */

import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const API = (flag('api', process.env.API_URL ?? 'http://localhost:4000')).replace(/\/$/, '');
const MONGO = flag('mongo', process.env.MONGODB_URI ?? 'mongodb://localhost:27017/codexa');
const KEEP = args.includes('--keep');

/** Usernames and emails are not secrets; passwords are, so they are not here. */
const PEOPLE = ['parth', 'joel', 'raghav'].map((username) => ({
  username,
  email: `${username}@codexa.app`,
  password:
    process.env[`SEED_PASSWORD_${username.toUpperCase()}`] ??
    // 18 random bytes, not a memorable default: a default that ships in the
    // repository is the same as no password at all.
    randomBytes(18).toString('base64url'),
  generated: !process.env[`SEED_PASSWORD_${username.toUpperCase()}`],
}));

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${json?.error?.message ?? text}`);
  }
  return json;
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`The API is not answering at ${API}. Start it with: npm run dev:api`);
  }

  if (!KEEP) {
    // Drops indexes as well as documents, which is the point: a database left
    // over from the Clerk era still carries a unique index on `clerkId`, and a
    // field that no longer exists reads as null for every row — so the second
    // account to be created would collide with the first. Restart the API after
    // a wipe so Mongoose rebuilds the indexes it expects.
    await mongoose.connect(MONGO);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    console.log('dropped the database (documents and indexes)');
  }

  const sessions = {};
  for (const person of PEOPLE) {
    try {
      const created = await api('/api/auth/signup', { method: 'POST', body: person });
      sessions[person.username] = created.token;
      console.log(`created ${person.username} <${person.email}>`);
    } catch (err) {
      if (!String(err).includes('409')) throw err;
      const signedIn = await api('/api/auth/login', {
        method: 'POST',
        body: { identifier: person.username, password: person.password },
      });
      sessions[person.username] = signedIn.token;
      console.log(`${person.username} already existed — signed in`);
    }
  }

  const owner = sessions.parth;
  const { project } = await api('/api/projects', {
    method: 'POST',
    body: {
      name: 'Codexa demo',
      description: 'Open it, send the link, edit together.',
      language: 'python',
      useTemplate: true,
    },
    token: owner,
  });
  console.log(`created project "${project.name}" owned by parth (${project.id})`);

  // Members join the way anyone else would: through a share link.
  const shared = await api(`/api/projects/${project.id}/share`, {
    method: 'POST',
    body: { role: 'editor' },
    token: owner,
  });
  const shareToken = shared.project.shareToken;

  for (const name of ['joel', 'raghav']) {
    await api('/api/projects/join', {
      method: 'POST',
      body: { token: shareToken },
      token: sessions[name],
    });
    console.log(`${name} joined as editor`);
  }

  console.log('\nSign in at http://localhost:5173/sign-in');
  for (const person of PEOPLE) {
    console.log(`  ${person.username.padEnd(7)} ${person.password}`);
  }
  if (PEOPLE.some((p) => p.generated)) {
    console.log(
      '\nGenerated passwords are printed once and nowhere else — copy them now.\n' +
        'Set SEED_PASSWORD_<NAME> to choose your own.',
    );
  }
}

main().catch((err) => {
  console.error(`\nseed failed: ${err.message}`);
  process.exitCode = 1;
});
