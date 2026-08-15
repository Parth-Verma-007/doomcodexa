import { describe, expect, it, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Types } from 'mongoose';
import * as docStore from './docStore.js';
import { Y_TEXT_KEY } from '../services/documents.js';

/**
 * CRDT convergence — the correctness heart of the application (§14).
 *
 * If this suite passes, concurrent editing is safe. If it fails, characters are
 * being lost or duplicated somewhere and nothing else about the product
 * matters. It runs on every push.
 *
 * The randomised cases use a seeded PRNG so a failure is reproducible: the seed
 * is printed with the assertion.
 */

/** mulberry32 — small, fast, and deterministic from a 32-bit seed. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['int', 'main', 'return', '0', ';', '{', '}', '\n', 'printf', '"hi"', ' '];

/**
 * A peer holding its own Y.Doc, exactly as a browser would. Updates are
 * captured rather than applied immediately so the test can deliver them out of
 * order, which is the situation a CRDT exists to survive.
 */
class Peer {
  readonly doc = new Y.Doc();
  readonly outbox: Uint8Array[] = [];

  constructor(readonly id: number) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Only broadcast changes this peer made locally, not ones it received.
      if (origin === 'remote') return;
      this.outbox.push(update);
    });
  }

  get text(): string {
    return this.doc.getText(Y_TEXT_KEY).toString();
  }

  edit(random: () => number): void {
    const text = this.doc.getText(Y_TEXT_KEY);
    const length = text.length;
    const roll = random();

    if (roll < 0.7 || length === 0) {
      const at = length === 0 ? 0 : Math.floor(random() * (length + 1));
      const word = WORDS[Math.floor(random() * WORDS.length)] as string;
      text.insert(Math.min(at, length), word);
    } else {
      const at = Math.floor(random() * length);
      const count = Math.min(1 + Math.floor(random() * 5), length - at);
      if (count > 0) text.delete(at, count);
    }
  }

  receive(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, 'remote');
  }

  destroy(): void {
    this.doc.destroy();
  }
}

describe('CRDT convergence', () => {
  it('converges when three peers edit concurrently and updates arrive out of order', () => {
    const seed = 0xc0de;
    const random = rng(seed);
    const peers = [new Peer(0), new Peer(1), new Peer(2)];

    // In-flight updates: {from, bytes}. Delivered in random order to model a
    // network that reorders and delays.
    const wire: Array<{ from: number; update: Uint8Array }> = [];

    for (let step = 0; step < 1000; step += 1) {
      const author = peers[Math.floor(random() * peers.length)] as Peer;
      author.edit(random);

      while (author.outbox.length > 0) {
        wire.push({ from: author.id, update: author.outbox.shift() as Uint8Array });
      }

      // Deliver a random subset, out of order, so a peer can be several
      // updates behind while still producing new edits of its own.
      const toDeliver = Math.floor(random() * Math.min(wire.length, 4));
      for (let i = 0; i < toDeliver; i += 1) {
        const index = Math.floor(random() * wire.length);
        const [packet] = wire.splice(index, 1);
        if (!packet) continue;
        for (const peer of peers) {
          if (peer.id !== packet.from) peer.receive(packet.update);
        }
      }
    }

    // Flush everything still in flight.
    for (const peer of peers) {
      while (peer.outbox.length > 0) {
        wire.push({ from: peer.id, update: peer.outbox.shift() as Uint8Array });
      }
    }
    while (wire.length > 0) {
      const packet = wire.shift() as { from: number; update: Uint8Array };
      for (const peer of peers) {
        if (peer.id !== packet.from) peer.receive(packet.update);
      }
    }

    const [a, b, c] = peers as [Peer, Peer, Peer];
    expect(a.text, `seed=${seed}`).toBe(b.text);
    expect(b.text, `seed=${seed}`).toBe(c.text);
    expect(a.text.length, `seed=${seed}`).toBeGreaterThan(0);

    peers.forEach((p) => p.destroy());
  });

  it('converges across many seeds', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = rng(seed);
      const peers = [new Peer(0), new Peer(1), new Peer(2), new Peer(3)];
      const wire: Array<{ from: number; update: Uint8Array }> = [];

      for (let step = 0; step < 200; step += 1) {
        const author = peers[Math.floor(random() * peers.length)] as Peer;
        author.edit(random);
        while (author.outbox.length > 0) {
          wire.push({ from: author.id, update: author.outbox.shift() as Uint8Array });
        }
        if (wire.length > 0 && random() < 0.5) {
          const index = Math.floor(random() * wire.length);
          const [packet] = wire.splice(index, 1);
          if (packet) {
            for (const peer of peers) {
              if (peer.id !== packet.from) peer.receive(packet.update);
            }
          }
        }
      }

      for (const peer of peers) {
        while (peer.outbox.length > 0) {
          wire.push({ from: peer.id, update: peer.outbox.shift() as Uint8Array });
        }
      }
      while (wire.length > 0) {
        const packet = wire.shift() as { from: number; update: Uint8Array };
        for (const peer of peers) {
          if (peer.id !== packet.from) peer.receive(packet.update);
        }
      }

      const texts = peers.map((p) => p.text);
      for (const text of texts) {
        expect(text, `seed=${seed}`).toBe(texts[0]);
      }
      peers.forEach((p) => p.destroy());
    }
  });

  it('merges edits made while a peer was disconnected', () => {
    const online = new Peer(0);
    const offline = new Peer(1);

    // Both start from the same base.
    online.doc.getText(Y_TEXT_KEY).insert(0, 'int main() {}');
    const base = Y.encodeStateAsUpdate(online.doc);
    offline.receive(base);
    online.outbox.length = 0;

    // They now edit in isolation — the offline peer's updates go nowhere.
    online.doc.getText(Y_TEXT_KEY).insert(13, '\n// online edit');
    offline.doc.getText(Y_TEXT_KEY).insert(0, '#include <stdio.h>\n');

    // Reconnect: exactly the step-1/step-2 exchange the provider performs.
    const onlineDiff = Y.encodeStateAsUpdate(online.doc, Y.encodeStateVector(offline.doc));
    const offlineDiff = Y.encodeStateAsUpdate(offline.doc, Y.encodeStateVector(online.doc));
    offline.receive(onlineDiff);
    online.receive(offlineDiff);

    expect(online.text).toBe(offline.text);
    expect(online.text).toContain('#include <stdio.h>');
    expect(online.text).toContain('// online edit');

    online.destroy();
    offline.destroy();
  });
});

describe('docStore', () => {
  afterEach(() => {
    docStore.resetForTests();
  });

  it('serves a late joiner the full document', async () => {
    const fileId = new Types.ObjectId().toHexString();
    const projectId = new Types.ObjectId().toHexString();

    const author = new Y.Doc();
    author.getText(Y_TEXT_KEY).insert(0, 'print("hello")');

    await docStore.subscribe(fileId, projectId);
    await docStore.applyUpdate(fileId, projectId, Y.encodeStateAsUpdate(author));

    // A second client arrives knowing nothing.
    const latecomer = new Y.Doc();
    const diff = await docStore.diffSince(fileId, projectId, Y.encodeStateVector(latecomer));
    Y.applyUpdate(latecomer, diff);

    expect(latecomer.getText(Y_TEXT_KEY).toString()).toBe('print("hello")');

    author.destroy();
    latecomer.destroy();
  });

  it('rejects an update larger than the wire limit', async () => {
    const fileId = new Types.ObjectId().toHexString();
    const projectId = new Types.ObjectId().toHexString();
    await docStore.subscribe(fileId, projectId);

    const huge = new Y.Doc();
    huge.getText(Y_TEXT_KEY).insert(0, 'x'.repeat(1_500_000));

    await expect(
      docStore.applyUpdate(fileId, projectId, Y.encodeStateAsUpdate(huge)),
    ).rejects.toBeInstanceOf(docStore.DocumentTooLargeError);

    huge.destroy();
  });

  it('persists the merged text, not whichever client wrote last', async () => {
    const fileId = new Types.ObjectId().toHexString();
    const projectId = new Types.ObjectId().toHexString();
    await docStore.subscribe(fileId, projectId);

    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText(Y_TEXT_KEY).insert(0, 'AAA');
    b.getText(Y_TEXT_KEY).insert(0, 'BBB');

    await docStore.applyUpdate(fileId, projectId, Y.encodeStateAsUpdate(a));
    await docStore.applyUpdate(fileId, projectId, Y.encodeStateAsUpdate(b));

    const merged = await docStore.textOf(fileId, projectId);
    expect(merged).toHaveLength(6);
    expect(merged).toContain('AAA');
    expect(merged).toContain('BBB');

    a.destroy();
    b.destroy();
  });
});
