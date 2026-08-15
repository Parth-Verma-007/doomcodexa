import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  FileDto,
  MemberDto,
  MessageDto,
  PresencePeer,
  ProjectDto,
  Role,
} from '@codexa/shared';
import { canEdit } from '@codexa/shared';
import {
  collabSocket,
  emitWithAck,
  onConnectionStatus,
  type ConnectionStatus,
} from '../../lib/socket.js';
import {
  createProjectAwareness,
  publishLocalAwareness,
  setLocalAwareness,
} from '../../lib/yjsProvider.js';
import { api } from '../../lib/api.js';
import { useUiStore } from '../../stores/uiStore.js';
import { disposeModel } from '../../lib/monaco.js';

/**
 * The realtime session for one project.
 *
 * Owns three things that must be created once and shared: the project-scoped
 * awareness instance, the collab socket room membership, and the live file
 * list. Everything below this in the tree reads from here rather than opening
 * its own connection.
 */

interface ProjectSession {
  projectId: string;
  project: ProjectDto | null;
  role: Role;
  canEdit: boolean;
  files: FileDto[];
  members: MemberDto[];
  peers: PresencePeer[];
  messages: MessageDto[];
  awareness: Awareness | null;
  /** The doc that owns the awareness clientID. Documents get their own docs. */
  sessionDoc: Y.Doc | null;
  connection: ConnectionStatus;
  joining: boolean;
  error: string | null;

  sendMessage: (body: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  announceActiveFile: (fileId: string | null) => void;
}

const Context = createContext<ProjectSession | null>(null);

export function useProject(): ProjectSession {
  const value = useContext(Context);
  if (!value) throw new Error('useProject must be used inside <ProjectProvider>');
  return value;
}

export function ProjectProvider({
  projectId,
  initial,
  children,
}: {
  projectId: string;
  initial: { project: ProjectDto; files: FileDto[]; members: MemberDto[] };
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const closeTabsFor = useUiStore((s) => s.closeTabsFor);
  const renameTab = useUiStore((s) => s.renameTab);

  const [project, setProject] = useState<ProjectDto | null>(initial.project);
  const [role, setRole] = useState<Role>(initial.project.myRole);
  const [files, setFiles] = useState<FileDto[]>(initial.files);
  const [members, setMembers] = useState<MemberDto[]>(initial.members);
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [joining, setJoining] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Created once per project and destroyed on unmount. Recreating it would
  // change our clientID and make us appear as a second ghost peer.
  const sessionDocRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  if (!sessionDocRef.current) {
    sessionDocRef.current = new Y.Doc();
    awarenessRef.current = createProjectAwareness(sessionDocRef.current);
  }

  useEffect(() => {
    return () => {
      awarenessRef.current?.destroy();
      sessionDocRef.current?.destroy();
      awarenessRef.current = null;
      sessionDocRef.current = null;
    };
  }, [projectId]);

  useEffect(() => onConnectionStatus(setConnection), []);

  /**
   * Publish who we are into awareness.
   *
   * Everything peer-facing keys off `state.user`: the avatar stack skips any
   * entry without one, and the remote-cursor stylesheet needs the name and
   * colour to draw a labelled caret. Without this the CRDT still syncs text
   * perfectly — but nobody can see anybody, which looks exactly like
   * collaboration being broken.
   *
   * `/api/me` is the only place the client learns its own identity; the socket
   * ack returns the *other* peers, never itself.
   */
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    staleTime: Infinity,
  });

  useEffect(() => {
    const awareness = awarenessRef.current;
    if (!awareness || !me) return;
    setLocalAwareness(awareness, { user: me.user, role });
    // Announce immediately as well as on change: if this resolved while
    // `room:join` was still in flight, the change event was emitted into a room
    // we were not yet in and the server dropped it.
    publishLocalAwareness(collabSocket(), projectId, awareness);
  }, [me, role, projectId]);

  // ─── Room membership and live events ────────────────────────────────────────

  useEffect(() => {
    const socket = collabSocket();
    let cancelled = false;

    const join = async () => {
      setJoining(true);
      try {
        const response = await emitWithAck<{
          ok: boolean;
          data?: { project: ProjectDto; role: Role; peers: PresencePeer[] };
          error?: { message: string };
        }>(socket, 'room:join', { projectId });

        if (cancelled) return;

        if (!response.ok || !response.data) {
          setError(response.error?.message ?? 'Could not join this project.');
          return;
        }

        setProject(response.data.project);
        setRole(response.data.role);
        setPeers(response.data.peers);
        setError(null);

        // Now that we are definitely in the room, say who we are. Covers the
        // opposite ordering from the identity effect below: our state was
        // already set, and its change event was the one that got dropped.
        publishLocalAwareness(socket, projectId, awarenessRef.current);
      } catch {
        if (!cancelled) setError('Lost contact with the server.');
      } finally {
        if (!cancelled) setJoining(false);
      }
    };

    void join();
    // Re-join after a reconnect: the server keeps no memory of the old socket.
    socket.on('connect', join);

    const onPeerJoined = ({ peer }: { peer: PresencePeer }) =>
      setPeers((current) =>
        current.some((p) => p.socketId === peer.socketId) ? current : [...current, peer],
      );

    const onPeerLeft = ({ socketId }: { socketId: string }) =>
      setPeers((current) => current.filter((p) => p.socketId !== socketId));

    const onFileCreated = ({ file }: { file: FileDto }) =>
      setFiles((current) => (current.some((f) => f.id === file.id) ? current : [...current, file]));

    const onFileUpdated = ({ file }: { file: FileDto; previousPath?: string }) => {
      setFiles((current) => {
        const next = current.map((f) => (f.id === file.id ? file : f));
        // A folder rename rewrites descendants server-side; the paths we hold
        // are now stale, so pull the authoritative list.
        if (file.type === 'folder') void refreshFiles();
        return next;
      });
      renameTab(file.id, file.name);
    };

    const onFilesDeleted = ({ fileIds }: { fileIds: string[] }) => {
      const doomed = new Set(fileIds);
      setFiles((current) => current.filter((f) => !doomed.has(f.id)));
      closeTabsFor(fileIds);
      // Free the Monaco models — otherwise a deleted file's undo stack and text
      // stay in memory for the life of the tab.
      for (const id of fileIds) disposeModel(id);
    };

    const onProjectUpdated = ({
      project: updated,
    }: {
      project: Omit<ProjectDto, 'myRole' | 'shareToken'>;
    }) => setProject((current) => (current ? { ...current, ...updated } : current));

    const onAclChanged = ({ role: nextRole }: { projectId: string; role: Role | null }) => {
      if (nextRole === null) {
        setError('Your access to this project was removed.');
        return;
      }
      setRole(nextRole);
      toast.info(`Your role is now ${nextRole}.`);
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    };

    const onChatMessage = ({ message }: { message: MessageDto }) =>
      setMessages((current) =>
        current.some((m) => m.id === message.id) ? current : [...current, message],
      );

    const onServerError = ({ message, context }: { message: string; context?: string }) => {
      // Per-keystroke rejections would be unbearable as toasts; the read-only
      // banner covers that case, so only surface everything else.
      if (context === 'sync:update') return;
      toast.error(message);
    };

    socket.on('peer:joined', onPeerJoined);
    socket.on('peer:left', onPeerLeft);
    socket.on('file:created', onFileCreated);
    socket.on('file:updated', onFileUpdated);
    socket.on('file:deleted', onFilesDeleted);
    socket.on('project:updated', onProjectUpdated);
    socket.on('acl:changed', onAclChanged);
    socket.on('chat:message', onChatMessage);
    socket.on('codexa:error', onServerError);

    return () => {
      cancelled = true;
      socket.emit('room:leave', { projectId });
      socket.off('connect', join);
      socket.off('peer:joined', onPeerJoined);
      socket.off('peer:left', onPeerLeft);
      socket.off('file:created', onFileCreated);
      socket.off('file:updated', onFileUpdated);
      socket.off('file:deleted', onFilesDeleted);
      socket.off('project:updated', onProjectUpdated);
      socket.off('acl:changed', onAclChanged);
      socket.off('chat:message', onChatMessage);
      socket.off('codexa:error', onServerError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Load chat history once; live messages arrive over the socket.
  useEffect(() => {
    let cancelled = false;
    void api
      .listMessages(projectId)
      .then(({ messages: history }) => {
        if (!cancelled) setMessages(history);
      })
      .catch(() => {
        /* chat history is non-critical; the panel simply starts empty */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshFiles = useCallback(async () => {
    const { files: fresh } = await api.listFiles(projectId);
    setFiles(fresh);
  }, [projectId]);

  const sendMessage = useCallback(
    async (body: string) => {
      const socket = collabSocket();
      const response = await emitWithAck<{ ok: boolean; error?: { message: string } }>(
        socket,
        'chat:send',
        { projectId, body },
      );
      if (!response.ok) throw new Error(response.error?.message ?? 'Message not sent.');
    },
    [projectId],
  );

  /** Publish which file we are looking at, so peers can follow us. */
  const announceActiveFile = useCallback((fileId: string | null) => {
    const awareness = awarenessRef.current;
    if (!awareness) return;
    setLocalAwareness(awareness, { activeFileId: fileId });
  }, []);

  const value = useMemo<ProjectSession>(
    () => ({
      projectId,
      project,
      role,
      canEdit: canEdit(role),
      files,
      members,
      peers,
      messages,
      awareness: awarenessRef.current,
      sessionDoc: sessionDocRef.current,
      connection,
      joining,
      error,
      sendMessage,
      refreshFiles,
      announceActiveFile,
    }),
    [
      projectId,
      project,
      role,
      files,
      members,
      peers,
      messages,
      connection,
      joining,
      error,
      sendMessage,
      refreshFiles,
      announceActiveFile,
    ],
  );

  useEffect(() => {
    setMembers(initial.members);
  }, [initial.members]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
