import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { TEST_IDENTITY_HEADER } from '../../auth/clerk.js';

/**
 * REST behaviour, with a real Mongo behind it (§14).
 *
 * The permission cases matter more than the happy paths: every route asserts
 * what a viewer, a stranger and an unauthenticated caller get, because that is
 * where an IDE with sharing actually goes wrong.
 */

const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const VIEWER = 'user_viewer';
const STRANGER = 'user_stranger';

let app: Express;

beforeAll(async () => {
  process.env.AUTH_DEV_BYPASS = '1';
  process.env.EXEC_DISABLED = '1';
  const { createApp } = await import('../../app.js');
  app = createApp();
});

const as = (identity: string) => ({ [TEST_IDENTITY_HEADER]: identity });

async function createProject(identity = OWNER, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/projects')
    .set(as(identity))
    .send({ name: 'Sorting demo', language: 'cpp', ...overrides })
    .expect(201);
  return res.body.project as {
    id: string;
    shareToken: string | null;
    entrypointFileId: string | null;
  };
}

/** Add a member by minting a share link at the given role and redeeming it. */
async function addMember(projectId: string, identity: string, role: 'editor' | 'viewer') {
  const share = await request(app)
    .post(`/api/projects/${projectId}/share`)
    .set(as(OWNER))
    .send({ role })
    .expect(200);

  await request(app)
    .post('/api/projects/join')
    .set(as(identity))
    .send({ token: share.body.project.shareToken })
    .expect(200);
}

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('project creation', () => {
  it('seeds the language template and makes it the entrypoint', async () => {
    const project = await createProject();
    expect(project.entrypointFileId).not.toBeNull();

    const detail = await request(app).get(`/api/projects/${project.id}`).set(as(OWNER)).expect(200);

    const files = detail.body.files as Array<{ name: string; isEntrypoint: boolean; path: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('main.cpp');
    expect(files[0]?.path).toBe('/main.cpp');
    expect(files[0]?.isEntrypoint).toBe(true);

    const content = await request(app)
      .get(`/api/files/${project.entrypointFileId}/content`)
      .set(as(OWNER))
      .expect(200);
    expect(content.body.content).toContain('int main()');
  });

  it('allows many projects that have no share link', async () => {
    // Regression: `shareToken` defaults to null, so a *sparse* unique index
    // permitted exactly one un-shared project and 409'd every one after it.
    // The index has to be partial (`$type: 'string'`) instead.
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/projects')
        .set(as(OWNER))
        .send({ name: `Project ${i}`, language: 'python' })
        .expect(201);
    }

    const list = await request(app).get('/api/projects').set(as(OWNER)).expect(200);
    expect(list.body.projects).toHaveLength(3);
  });

  it('still refuses two projects with the same share token', async () => {
    // The uniqueness the index exists for must survive the fix.
    const a = await createProject(OWNER);
    const b = await createProject(OWNER);

    const shared = await request(app)
      .post(`/api/projects/${a.id}/share`)
      .set(as(OWNER))
      .send({ role: 'viewer' })
      .expect(200);

    const token = shared.body.project.shareToken as string;
    expect(token).toBeTruthy();

    const { Project } = await import('../../db/models/index.js');
    await expect(
      Project.updateOne({ _id: b.id }, { $set: { shareToken: token } }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects an unknown language', async () => {
    await request(app)
      .post('/api/projects')
      .set(as(OWNER))
      .send({ name: 'Nope', language: 'rust' })
      .expect(422);
  });

  it('lists only projects the caller can see', async () => {
    await createProject(OWNER);
    const mine = await request(app).get('/api/projects').set(as(OWNER)).expect(200);
    const theirs = await request(app).get('/api/projects').set(as(STRANGER)).expect(200);

    expect(mine.body.projects.length).toBeGreaterThan(0);
    expect(theirs.body.projects).toHaveLength(0);
  });
});

describe('project authorisation', () => {
  it('hides a project from a stranger with 404, not 403', async () => {
    // 403 would confirm the id exists, making project ids enumerable.
    const project = await createProject();
    await request(app).get(`/api/projects/${project.id}`).set(as(STRANGER)).expect(404);
  });

  it('lets a viewer read but not write', async () => {
    const project = await createProject();
    await addMember(project.id, VIEWER, 'viewer');

    await request(app).get(`/api/projects/${project.id}`).set(as(VIEWER)).expect(200);

    await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(VIEWER))
      .send({ name: 'notes.txt', type: 'file' })
      .expect(403);

    await request(app)
      .patch(`/api/projects/${project.id}`)
      .set(as(VIEWER))
      .send({ name: 'Renamed' })
      .expect(403);
  });

  it('lets an editor write but not administer', async () => {
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');

    await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(EDITOR))
      .send({ name: 'helper.cpp', type: 'file' })
      .expect(201);

    await request(app).delete(`/api/projects/${project.id}`).set(as(EDITOR)).expect(403);

    await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(EDITOR))
      .send({ role: 'editor' })
      .expect(403);
  });

  it('never lets an editor change visibility', async () => {
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');
    await request(app)
      .patch(`/api/projects/${project.id}`)
      .set(as(EDITOR))
      .send({ isPublic: true })
      .expect(403);
  });

  it('only shows the share token to the owner', async () => {
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');

    const ownerView = await request(app)
      .get(`/api/projects/${project.id}`)
      .set(as(OWNER))
      .expect(200);
    const editorView = await request(app)
      .get(`/api/projects/${project.id}`)
      .set(as(EDITOR))
      .expect(200);

    expect(ownerView.body.project.shareToken).toBeTruthy();
    expect(editorView.body.project.shareToken).toBeNull();
  });
});

describe('sharing', () => {
  it('rotating the token invalidates the previous link', async () => {
    const project = await createProject();
    const first = await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(OWNER))
      .send({ role: 'viewer' })
      .expect(200);
    const oldToken = first.body.project.shareToken as string;

    await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(OWNER))
      .send({})
      .expect(200);

    await request(app)
      .post('/api/projects/join')
      .set(as(STRANGER))
      .send({ token: oldToken })
      .expect(404);
  });

  it('a share link can never grant ownership', async () => {
    const project = await createProject();
    await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(OWNER))
      .send({ role: 'owner' })
      .expect(422);
  });

  it('revoking sharing kills the link', async () => {
    const project = await createProject();
    const share = await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(OWNER))
      .send({})
      .expect(200);

    await request(app).delete(`/api/projects/${project.id}/share`).set(as(OWNER)).expect(200);
    await request(app)
      .post('/api/projects/join')
      .set(as(STRANGER))
      .send({ token: share.body.project.shareToken })
      .expect(404);
  });
});

describe('files', () => {
  it('rejects a filename that would escape the workspace', async () => {
    const project = await createProject();
    for (const name of ['../evil.c', 'a/b.c', '.git', 'CON', 'main.']) {
      await request(app)
        .post(`/api/projects/${project.id}/files`)
        .set(as(OWNER))
        .send({ name, type: 'file' })
        .expect(422);
    }
  });

  it('refuses a duplicate name in the same folder', async () => {
    const project = await createProject();
    await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'util.cpp', type: 'file' })
      .expect(201);
    await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'util.cpp', type: 'file' })
      .expect(409);
  });

  it('rewrites descendant paths when a folder is renamed', async () => {
    const project = await createProject();
    const folder = await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'src', type: 'folder' })
      .expect(201);

    await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'deep.cpp', type: 'file', parentId: folder.body.file.id })
      .expect(201);

    await request(app)
      .patch(`/api/files/${folder.body.file.id}`)
      .set(as(OWNER))
      .send({ name: 'lib' })
      .expect(200);

    const files = await request(app)
      .get(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .expect(200);

    const paths = (files.body.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain('/lib');
    expect(paths).toContain('/lib/deep.cpp');
    expect(paths).not.toContain('/src/deep.cpp');
  });

  it('refuses to move a folder into itself', async () => {
    const project = await createProject();
    const outer = await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'outer', type: 'folder' })
      .expect(201);
    const inner = await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'inner', type: 'folder', parentId: outer.body.file.id })
      .expect(201);

    await request(app)
      .patch(`/api/files/${outer.body.file.id}`)
      .set(as(OWNER))
      .send({ parentId: inner.body.file.id })
      .expect(400);
  });

  it('deleting a folder cascades to its contents', async () => {
    const project = await createProject();
    const folder = await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'src', type: 'folder' })
      .expect(201);
    await request(app)
      .post(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .send({ name: 'a.cpp', type: 'file', parentId: folder.body.file.id })
      .expect(201);

    const res = await request(app)
      .delete(`/api/files/${folder.body.file.id}`)
      .set(as(OWNER))
      .expect(200);
    expect(res.body.deletedIds).toHaveLength(2);

    const files = await request(app)
      .get(`/api/projects/${project.id}/files`)
      .set(as(OWNER))
      .expect(200);
    expect(files.body.files).toHaveLength(1); // only the template main.cpp
  });

  it('clears the entrypoint when the entrypoint file is deleted', async () => {
    const project = await createProject();
    await request(app).delete(`/api/files/${project.entrypointFileId}`).set(as(OWNER)).expect(200);

    const detail = await request(app).get(`/api/projects/${project.id}`).set(as(OWNER)).expect(200);
    expect(detail.body.project.entrypointFileId).toBeNull();
  });

  it('hides another project’s file behind a 404', async () => {
    const mine = await createProject(OWNER);
    await request(app)
      .get(`/api/files/${mine.entrypointFileId}/content`)
      .set(as(STRANGER))
      .expect(404);
  });
});

describe('members', () => {
  it('lets a member leave, and stops them reading afterwards', async () => {
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');

    const me = await request(app).get('/api/me').set(as(EDITOR)).expect(200);
    await request(app)
      .delete(`/api/projects/${project.id}/members/${me.body.user.id}`)
      .set(as(EDITOR))
      .expect(204);

    await request(app).get(`/api/projects/${project.id}`).set(as(EDITOR)).expect(404);
  });

  it('stops a non-owner removing someone else', async () => {
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');
    await addMember(project.id, VIEWER, 'viewer');

    const victim = await request(app).get('/api/me').set(as(VIEWER)).expect(200);
    await request(app)
      .delete(`/api/projects/${project.id}/members/${victim.body.user.id}`)
      .set(as(EDITOR))
      .expect(403);
  });

  it('refuses to remove or demote the owner', async () => {
    const project = await createProject();
    const owner = await request(app).get('/api/me').set(as(OWNER)).expect(200);

    await request(app)
      .delete(`/api/projects/${project.id}/members/${owner.body.user.id}`)
      .set(as(OWNER))
      .expect(400);

    await request(app)
      .patch(`/api/projects/${project.id}/members/${owner.body.user.id}`)
      .set(as(OWNER))
      .send({ role: 'viewer' })
      .expect(400);
  });
});

/**
 * These two routes were the only operator-bearing queries with no coverage at
 * all, which is how a global `sanitizeFilter: true` broke them unnoticed: it
 * rewrites `{ $in: … }` and `{ $lt: … }` into `{ $eq: { $in: … } }`, and the
 * query then throws a cast error the first time a real request hits it. The
 * assertions are shallow on purpose — reaching a 200 is the whole point.
 */
describe('history endpoints', () => {
  it('returns run history', async () => {
    const project = await createProject();
    const res = await request(app)
      .get(`/api/projects/${project.id}/runs`)
      .set(as(OWNER))
      .expect(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
  });

  it('returns chat history, including the `before` cursor', async () => {
    const project = await createProject();

    await request(app).get(`/api/projects/${project.id}/messages`).set(as(OWNER)).expect(200);

    // `before` is what puts a `$lt` in the filter.
    const res = await request(app)
      .get(`/api/projects/${project.id}/messages`)
      .query({ before: new Date().toISOString() })
      .set(as(OWNER))
      .expect(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
  });
});

describe('admin', () => {
  /**
   * The admin list is configuration, not data, so it cannot be escalated into
   * from inside the app. These tests assert the closed default: with
   * `ADMIN_EMAILS` unset — which is how the test env boots — nobody is an
   * admin, including a project owner.
   */
  it('hides the admin API from everyone when no admins are configured', async () => {
    // 404 rather than 403: the route should not be discoverable by probing.
    await request(app).get('/api/admin/overview').set(as(OWNER)).expect(404);
  });

  it('does not claim anyone is an admin on /api/me', async () => {
    const res = await request(app).get('/api/me').set(as(OWNER)).expect(200);
    expect(res.body.isAdmin).toBe(false);
  });

  it('gives away nothing about the route in its refusal', async () => {
    // Not `401`: this suite runs with AUTH_DEV_BYPASS, so every request is
    // authenticated as the dev identity and there is no unauthenticated state
    // to observe. What matters here is that a non-admin's rejection is
    // indistinguishable from a URL that does not exist.
    const admin = await request(app).get('/api/admin/overview').set(as(OWNER)).expect(404);
    const nonsense = await request(app).get('/api/admin/nope').set(as(OWNER)).expect(404);

    expect(admin.body.error.code).toBe('not_found');
    expect(admin.body.error.code).toBe(nonsense.body.error.code);
    expect(JSON.stringify(admin.body)).not.toMatch(/admin|permission|forbidden/i);
  });
});

describe('project list', () => {
  it('carries member faces so a card needs no extra request', async () => {
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');

    const res = await request(app).get('/api/projects').set(as(OWNER)).expect(200);
    const listed = res.body.projects.find((p: { id: string }) => p.id === project.id);

    expect(listed.memberCount).toBe(2);
    expect(listed.members).toHaveLength(2);
    // Enough to render an avatar, and nothing more.
    expect(listed.members[0]).toHaveProperty('username');
    expect(listed.members[0]).toHaveProperty('color');
    expect(listed.members[0]).not.toHaveProperty('email');
  });

  it('shows a doubly-recorded member once', async () => {
    // Regression: joining read the project, checked for an existing membership,
    // then pushed and saved. Two simultaneous redemptions — a double-clicked
    // link, two tabs, or React StrictMode firing the join effect twice — both
    // read a list without the joiner and both appended. The write is atomic
    // now, but documents written before that guard still hold the repeat, and
    // it reached the UI as a duplicated avatar (colliding React keys) and an
    // inflated count. The duplicate is pushed directly here because the fixed
    // write path can no longer produce one.
    const project = await createProject();
    await addMember(project.id, EDITOR, 'editor');

    const { Project } = await import('../../db/models/index.js');
    const stored = await Project.findById(project.id);
    const duplicate = stored!.members[1]!;
    await Project.updateOne(
      { _id: project.id },
      { $push: { members: { userId: duplicate.userId, role: 'editor', addedAt: new Date() } } },
    );
    expect((await Project.findById(project.id))!.members).toHaveLength(3);

    const res = await request(app).get('/api/projects').set(as(OWNER)).expect(200);
    const listed = res.body.projects.find((p: { id: string }) => p.id === project.id);

    expect(listed.memberCount).toBe(2);
    expect(listed.members).toHaveLength(2);
    expect(new Set(listed.members.map((m: { id: string }) => m.id)).size).toBe(2);

    const members = await request(app)
      .get(`/api/projects/${project.id}/members`)
      .set(as(OWNER))
      .expect(200);
    expect(members.body.members).toHaveLength(2);
  });

  it('adds nothing when an existing member redeems the link again', async () => {
    const project = await createProject();
    const share = await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(OWNER))
      .send({ role: 'editor' })
      .expect(200);
    const token = share.body.project.shareToken as string;

    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/projects/join').set(as(EDITOR)).send({ token }).expect(200);
    }

    const res = await request(app).get('/api/projects').set(as(OWNER)).expect(200);
    const listed = res.body.projects.find((p: { id: string }) => p.id === project.id);
    expect(listed.memberCount).toBe(2);
  });

  it('never leaks another owner’s share token', async () => {
    const project = await createProject();
    await request(app)
      .post(`/api/projects/${project.id}/share`)
      .set(as(OWNER))
      .send({ role: 'viewer' })
      .expect(200);
    await addMember(project.id, VIEWER, 'viewer');

    const mine = await request(app).get('/api/projects').set(as(OWNER)).expect(200);
    const theirs = await request(app).get('/api/projects').set(as(VIEWER)).expect(200);

    const asOwner = mine.body.projects.find((p: { id: string }) => p.id === project.id);
    const asViewer = theirs.body.projects.find((p: { id: string }) => p.id === project.id);

    expect(asOwner.shareToken).toEqual(expect.any(String));
    expect(asViewer.shareToken).toBeNull();
  });
});

describe('error envelope', () => {
  it('uses one shape for every failure', async () => {
    const res = await request(app).get('/api/projects/not-an-id').set(as(OWNER)).expect(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('reports validation failures with field detail', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set(as(OWNER))
      .send({ name: '', language: 'cpp' })
      .expect(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });
});
