import { useEffect, useRef, useState } from 'react';
import { MessagesSquare, Send } from 'lucide-react';
import { toast } from 'sonner';
import { LIMITS } from '@codexa/shared';
import { useProject } from '../project/ProjectContext.js';
import { Avatar } from '../../components/Avatar.js';
import { formatRelativeTime } from '../../lib/utils.js';

export function ChatPanel() {
  const { messages, sendMessage } = useProject();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Only autoscroll when the reader is already at the bottom — yanking them
  // down mid-scrollback because someone else typed is hostile.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    try {
      await sendMessage(body);
      setDraft('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Message not sent.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Chat</h2>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="inline-flex rounded-lg bg-accent/12 p-2 text-accent">
              <MessagesSquare size={16} />
            </span>
            <p className="text-sm text-ink-muted">No messages yet</p>
            <p className="max-w-[14rem] text-xs text-ink-faint">
              Ask about a line, or leave a note for whoever opens this next.
            </p>
          </div>
        ) : (
          messages.map((message, index) => {
            // Collapse the avatar and name for runs from the same person.
            const previous = messages[index - 1];
            const grouped =
              previous?.author.id === message.author.id &&
              new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
                5 * 60_000;

            return (
              <div key={message.id} className="flex gap-2.5">
                <div className="w-7 shrink-0">
                  {grouped ? null : <Avatar user={message.author} size={28} />}
                </div>
                <div className="min-w-0 flex-1">
                  {grouped ? null : (
                    <div className="mb-0.5 flex items-baseline gap-2">
                      <span className="text-sm font-medium" style={{ color: message.author.color }}>
                        {message.author.username}
                      </span>
                      <time className="text-[10px] text-ink-faint" dateTime={message.createdAt}>
                        {formatRelativeTime(message.createdAt)}
                      </time>
                    </div>
                  )}
                  <p className="break-words text-sm text-ink-muted">{message.body}</p>
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) =>
              setDraft(event.target.value.slice(0, LIMITS.MAX_CHAT_MESSAGE_LENGTH))
            }
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline, as in every chat app.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder="Message the room…"
            aria-label="Message"
            className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-border bg-surface-0 px-2.5 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={draft.trim().length === 0 || sending}
            aria-label="Send"
            className="rounded-md bg-accent p-2 text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
