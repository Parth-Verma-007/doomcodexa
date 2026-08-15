import { useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  TriangleAlert,
} from 'lucide-react';
import { LIMITS } from '@codexa/shared';
import { usePeerMesh, type RemotePeer } from './usePeerMesh.js';
import { Avatar } from '../../components/Avatar.js';
import { Button } from '../../components/Button.js';
import { cn } from '../../lib/utils.js';

export function CallPanel({ projectId }: { projectId: string }) {
  const mesh = usePeerMesh(projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Voice</h2>
        <span className="text-[11px] text-ink-faint">
          {mesh.peers.length + (mesh.joined ? 1 : 0)}/{LIMITS.MAX_RTC_PEERS}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!mesh.joined ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-ink-muted">
              Talk while you code. Audio is peer-to-peer — it never touches the server.
            </p>
            <Button variant="primary" onClick={() => void mesh.join()} disabled={mesh.isFull}>
              <Phone size={14} />
              {mesh.isFull ? 'Call is full' : 'Join call'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {mesh.iceFailed ? (
              <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  Could not establish a direct connection to one peer. Your network probably
                  requires a TURN relay, which this deployment does not run.
                </span>
              </div>
            ) : null}

            {mesh.peers.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-faint">
                You are the only one here. Share the project link to invite someone.
              </p>
            ) : (
              mesh.peers.map((peer) => <PeerTile key={peer.peerId} peer={peer} />)
            )}
          </div>
        )}
      </div>

      {mesh.joined ? (
        <div className="flex items-center justify-center gap-1.5 border-t border-border p-2">
          <ControlButton
            active={mesh.media.audio}
            onClick={mesh.toggleAudio}
            label={mesh.media.audio ? 'Mute' : 'Unmute'}
          >
            {mesh.media.audio ? <Mic size={15} /> : <MicOff size={15} />}
          </ControlButton>

          <ControlButton
            active={mesh.media.video}
            onClick={() => void mesh.toggleVideo()}
            label={mesh.media.video ? 'Turn camera off' : 'Turn camera on'}
          >
            {mesh.media.video ? <Video size={15} /> : <VideoOff size={15} />}
          </ControlButton>

          <ControlButton
            active={mesh.media.screen}
            onClick={() => void mesh.toggleScreenShare()}
            label={mesh.media.screen ? 'Stop sharing' : 'Share your screen'}
          >
            <MonitorUp size={15} />
          </ControlButton>

          <button
            type="button"
            onClick={mesh.leave}
            aria-label="Leave the call"
            title="Leave the call"
            className="ml-2 rounded-md bg-danger/15 p-2 text-danger transition-colors hover:bg-danger/25"
          >
            <PhoneOff size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PeerTile({ peer }: { peer: RemotePeer }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Attaching a MediaStream is imperative — it cannot be a React prop.
    if (audioRef.current && peer.stream) audioRef.current.srcObject = peer.stream;
    if (videoRef.current && peer.stream) videoRef.current.srcObject = peer.stream;
  }, [peer.stream]);

  const showVideo = peer.media.video || peer.media.screen;
  const connecting = peer.connectionState !== 'connected';

  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-2">
      {showVideo ? (
        // A live WebRTC stream has no caption track to attach — captions would
        // require speech-to-text, which is out of scope. The rule is disabled
        // here rather than repo-wide so a real <video src> still gets caught.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={videoRef}
          autoPlay
          playsInline
          aria-label={`${peer.user.username}'s ${peer.media.screen ? 'screen' : 'camera'}`}
          className="aspect-video w-full bg-black object-contain"
        />
      ) : null}

      <div className="flex items-center gap-2 px-2.5 py-2">
        <Avatar user={peer.user} size={24} ring />
        <span className="truncate text-sm">{peer.user.username}</span>

        <span className="ml-auto flex items-center gap-1.5">
          {connecting ? (
            <span className="text-[10px] text-ink-faint">
              {peer.connectionState === 'failed' ? 'unreachable' : 'connecting…'}
            </span>
          ) : null}
          {peer.media.screen ? <MonitorUp size={12} className="text-accent" /> : null}
          {peer.media.audio ? (
            <Mic size={12} className="text-success" />
          ) : (
            <MicOff size={12} className="text-ink-faint" />
          )}
        </span>
      </div>

      {/* Audio always plays, even when there is no video tile to show. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} autoPlay aria-label={`${peer.user.username}'s microphone`} />
    </div>
  );
}

function ControlButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'rounded-md p-2 transition-colors',
        active
          ? 'bg-accent/15 text-accent hover:bg-accent/25'
          : 'bg-surface-2 text-ink-muted hover:bg-surface-3 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
