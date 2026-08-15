import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { LIMITS, type RtcMediaState, type RtcPeer, type UserDto } from '@codexa/shared';
import { emitWithAck, rtcSocket } from '../../lib/socket.js';

/**
 * A full-mesh WebRTC call (§9).
 *
 * Media is peer-to-peer, so voice and video cost the server nothing — it only
 * relays SDP and ICE. That is the whole reason for a mesh at this scale, and
 * also why it is hard-capped at four: every peer uploads N-1 copies of its
 * stream, which stops working on residential upload past that. Beyond four you
 * need an SFU.
 *
 * The subtle part is **perfect negotiation**. When two peers offer at the same
 * moment ("glare"), a naive implementation deadlocks or drops the connection
 * intermittently. The standard fix assigns each side a role from a value both
 * agree on — here, comparing peer ids — and only the "polite" peer rolls back
 * its own offer to accept the other's.
 */

export interface RemotePeer {
  peerId: string;
  user: UserDto;
  media: RtcMediaState;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface Connection {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

export function usePeerMesh(projectId: string) {
  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [media, setMedia] = useState<RtcMediaState>({ audio: false, video: false, screen: false });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [iceFailed, setIceFailed] = useState(false);

  const connections = useRef(new Map<string, Connection>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const myPeerId = useRef<string | null>(null);

  const updatePeer = useCallback((peerId: string, patch: Partial<RemotePeer>) => {
    setPeers((current) => current.map((p) => (p.peerId === peerId ? { ...p, ...patch } : p)));
  }, []);

  // ─── Connection factory ─────────────────────────────────────────────────────

  const createConnection = useCallback(
    (peerId: string): Connection => {
      const existing = connections.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      // Politeness must be decided identically on both sides without any
      // negotiation of its own — comparing the two ids does exactly that.
      const polite = (myPeerId.current ?? '') > peerId;
      const connection: Connection = { pc, polite, makingOffer: false, ignoreOffer: false };
      connections.current.set(peerId, connection);

      for (const track of localStreamRef.current?.getTracks() ?? []) {
        pc.addTrack(track, localStreamRef.current as MediaStream);
      }

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) updatePeer(peerId, { stream });
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          rtcSocket().emit('rtc:ice', { to: peerId, candidate: event.candidate.toJSON() });
        }
      };

      pc.onnegotiationneeded = () => {
        void (async () => {
          try {
            connection.makingOffer = true;
            await pc.setLocalDescription();
            rtcSocket().emit('rtc:offer', { to: peerId, sdp: JSON.stringify(pc.localDescription) });
          } catch {
            /* the connection is closing */
          } finally {
            connection.makingOffer = false;
          }
        })();
      };

      pc.onconnectionstatechange = () => {
        updatePeer(peerId, { connectionState: pc.connectionState });
        if (pc.connectionState === 'failed') {
          // STUN-only cannot traverse a symmetric NAT. Say so plainly rather
          // than leaving a silent black tile (§9).
          setIceFailed(true);
        }
      };

      return connection;
    },
    [updatePeer],
  );

  const closeConnection = useCallback((peerId: string) => {
    const connection = connections.current.get(peerId);
    if (!connection) return;
    connection.pc.ontrack = null;
    connection.pc.onicecandidate = null;
    connection.pc.onnegotiationneeded = null;
    connection.pc.close();
    connections.current.delete(peerId);
  }, []);

  // ─── Signalling ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = rtcSocket();

    const onPeerJoined = ({ peer }: { peer: RtcPeer }) => {
      setPeers((current) =>
        current.some((p) => p.peerId === peer.peerId)
          ? current
          : [
              ...current,
              {
                peerId: peer.peerId,
                user: peer.user,
                media: peer.media,
                stream: null,
                connectionState: 'new' as RTCPeerConnectionState,
              },
            ],
      );
      // The existing member initiates; `onnegotiationneeded` fires once tracks
      // are attached, so no explicit offer is needed here.
      createConnection(peer.peerId);
    };

    const onPeerLeft = ({ peerId }: { peerId: string }) => {
      closeConnection(peerId);
      setPeers((current) => current.filter((p) => p.peerId !== peerId));
    };

    const onOffer = ({ from, sdp }: { from: string; sdp: string }) => {
      void (async () => {
        const connection = createConnection(from);
        const description = JSON.parse(sdp) as RTCSessionDescriptionInit;

        // Glare: both sides offered at once.
        const offerCollision = connection.makingOffer || connection.pc.signalingState !== 'stable';
        connection.ignoreOffer = !connection.polite && offerCollision;
        if (connection.ignoreOffer) return;

        // The polite peer rolls its own offer back and accepts theirs.
        await connection.pc.setRemoteDescription(description);
        await connection.pc.setLocalDescription();
        rtcSocket().emit('rtc:answer', {
          to: from,
          sdp: JSON.stringify(connection.pc.localDescription),
        });
      })().catch(() => {
        /* a failed negotiation surfaces through connectionState */
      });
    };

    const onAnswer = ({ from, sdp }: { from: string; sdp: string }) => {
      const connection = connections.current.get(from);
      if (!connection) return;
      void connection.pc
        .setRemoteDescription(JSON.parse(sdp) as RTCSessionDescriptionInit)
        .catch(() => {});
    };

    const onIce = ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const connection = connections.current.get(from);
      if (!connection) return;
      void connection.pc.addIceCandidate(candidate).catch(() => {
        // Expected when an offer was ignored during glare — the candidate has
        // nowhere to go and dropping it is correct.
        if (!connection.ignoreOffer) return;
      });
    };

    const onMediaState = ({ peerId, media: state }: { peerId: string; media: RtcMediaState }) =>
      updatePeer(peerId, { media: state });

    socket.on('rtc:peer-joined', onPeerJoined);
    socket.on('rtc:peer-left', onPeerLeft);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);
    socket.on('rtc:media-state', onMediaState);

    return () => {
      socket.off('rtc:peer-joined', onPeerJoined);
      socket.off('rtc:peer-left', onPeerLeft);
      socket.off('rtc:offer', onOffer);
      socket.off('rtc:answer', onAnswer);
      socket.off('rtc:ice', onIce);
      socket.off('rtc:media-state', onMediaState);
    };
  }, [createConnection, closeConnection, updatePeer]);

  // ─── Public actions ─────────────────────────────────────────────────────────

  const join = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const response = await emitWithAck<{
        ok: boolean;
        data?: { peerId: string; peers: RtcPeer[] };
        error?: { message: string };
      }>(rtcSocket(), 'rtc:join', {
        projectId,
        media: { audio: true, video: false, screen: false },
      });

      if (!response.ok || !response.data) {
        stream.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        setLocalStream(null);
        toast.error(response.error?.message ?? 'Could not join the call.');
        return;
      }

      myPeerId.current = response.data.peerId;
      setJoined(true);
      setMedia({ audio: true, video: false, screen: false });

      setPeers(
        response.data.peers.map((peer) => ({
          peerId: peer.peerId,
          user: peer.user,
          media: peer.media,
          stream: null,
          connectionState: 'new' as RTCPeerConnectionState,
        })),
      );

      // We are the newcomer: open a connection to everyone already here.
      for (const peer of response.data.peers) createConnection(peer.peerId);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      toast.error(
        denied
          ? 'Microphone access was blocked. Allow it in your browser to join the call.'
          : 'Could not access your microphone.',
      );
    }
  }, [projectId, createConnection]);

  const leave = useCallback(() => {
    rtcSocket().emit('rtc:leave', { projectId });
    for (const peerId of [...connections.current.keys()]) closeConnection(peerId);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setPeers([]);
    setJoined(false);
    setMedia({ audio: false, video: false, screen: false });
    setIceFailed(false);
  }, [projectId, closeConnection]);

  const publishMedia = useCallback(
    (next: RtcMediaState) => {
      setMedia(next);
      rtcSocket().emit('rtc:media-state', { projectId, media: next });
    },
    [projectId],
  );

  const toggleAudio = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    publishMedia({ ...media, audio: track.enabled });
  }, [media, publishMedia]);

  const toggleVideo = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const existing = stream.getVideoTracks()[0];
    if (existing) {
      existing.stop();
      stream.removeTrack(existing);
      for (const { pc } of connections.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) pc.removeTrack(sender);
      }
      publishMedia({ ...media, video: false });
      return;
    }

    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = camera.getVideoTracks()[0];
      if (!track) return;
      stream.addTrack(track);
      for (const { pc } of connections.current.values()) pc.addTrack(track, stream);
      publishMedia({ ...media, video: true });
    } catch {
      toast.error('Could not access your camera.');
    }
  }, [media, publishMedia]);

  const toggleScreenShare = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    if (media.screen) {
      publishMedia({ ...media, screen: false });
      return;
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      if (!track) return;

      // `replaceTrack` swaps the outgoing video without renegotiating, so the
      // switch is instant and does not risk another round of glare.
      for (const { pc } of connections.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(track);
        else pc.addTrack(track, stream);
      }

      track.onended = () => publishMedia({ ...media, screen: false });
      publishMedia({ ...media, screen: true });
    } catch {
      /* the user dismissed the picker */
    }
  }, [media, publishMedia]);

  useEffect(() => () => leave(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    joined,
    peers,
    media,
    localStream,
    iceFailed,
    isFull: peers.length >= LIMITS.MAX_RTC_PEERS,
    join,
    leave,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
  };
}
