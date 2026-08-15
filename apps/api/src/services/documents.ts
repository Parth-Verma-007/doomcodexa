import * as Y from 'yjs';
import { LIMITS } from '@codexa/shared';
import { YDocState } from '../db/models/index.js';
import { ApiError } from '../http/errors.js';

/**
 * CRDT document storage.
 *
 * The Y.Text is always named `monaco` — the same key the client binds Monaco
 * to. Anything that creates a document must go through here so that name never
 * drifts, because a mismatch produces an empty editor with no error.
 */
export const Y_TEXT_KEY = 'monaco';

/** Build the initial CRDT state for a new file. */
export function encodeInitialState(text: string): Buffer {
  const doc = new Y.Doc();
  if (text.length > 0) {
    doc.getText(Y_TEXT_KEY).insert(0, text);
  }
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return state;
}

export function textFromState(state: Buffer | Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(state));
  const text = doc.getText(Y_TEXT_KEY).toString();
  doc.destroy();
  return text;
}

export async function createDocument(
  fileId: string,
  projectId: string,
  text: string,
): Promise<void> {
  if (text.length > LIMITS.MAX_DOC_BYTES) {
    throw ApiError.tooLarge('File content exceeds the 2 MB limit.');
  }
  await YDocState.create({
    fileId,
    projectId,
    state: encodeInitialState(text),
    plainText: text,
    version: 0,
  });
}

/** The stored snapshot for a file, creating an empty one on first access. */
export async function loadState(fileId: string, projectId: string): Promise<Uint8Array> {
  // Not `.lean()`: lean returns the BSON `Binary` wrapper rather than a Buffer,
  // and handing that to Yjs decodes as garbage.
  const existing = await YDocState.findOne({ fileId });
  if (existing) return new Uint8Array(existing.state);

  const state = encodeInitialState('');
  await YDocState.create({ fileId, projectId, state, plainText: '', version: 0 });
  return new Uint8Array(state);
}

/** Persist a snapshot plus its derived plain text (§7). */
export async function persistState(
  fileId: string,
  state: Uint8Array,
  plainText: string,
): Promise<void> {
  await YDocState.updateOne(
    { fileId },
    {
      $set: { state: Buffer.from(state), plainText },
      $inc: { version: 1 },
    },
  );
}

/** The derived text cache — used to materialise a run workspace (§8). */
export async function getPlainText(fileId: string): Promise<string> {
  const doc = await YDocState.findOne({ fileId }).select('plainText').lean();
  return doc?.plainText ?? '';
}

export async function getProjectTexts(projectId: string): Promise<Map<string, string>> {
  const docs = await YDocState.find({ projectId }).select('fileId plainText').lean();
  return new Map(docs.map((d) => [String(d.fileId), d.plainText ?? '']));
}

export async function deleteDocuments(fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  await YDocState.deleteMany({ fileId: { $in: fileIds } });
}
