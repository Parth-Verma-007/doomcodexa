import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { NS } from '@codexa/shared';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { installCollabNamespace } from './collab.js';
import { installRunNamespace } from './run.js';
import { installRtcNamespace } from './rtc.js';
import { attachBus, detachBus } from './bus.js';

/**
 * Three namespaces over one physical connection (§11): `/collab`, `/run` and
 * `/rtc`. Each gets its own auth middleware and event table, but the browser
 * still opens a single transport.
 */
export function createRealtimeServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    // Yjs updates are binary; leave them binary.
    // 2MB matches the document ceiling, so an oversized frame is rejected by
    // the transport before it can reach a handler.
    maxHttpBufferSize: 2 * 1024 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // WebSocket first. Long-polling remains as a fallback for hostile networks,
    // but upgrading immediately avoids a slow first sync.
    transports: ['websocket', 'polling'],
  });

  installCollabNamespace(io.of(NS.collab));
  installRunNamespace(io.of(NS.run));
  installRtcNamespace(io.of(NS.rtc));

  attachBus(io);

  logger.info({ namespaces: Object.values(NS) }, 'realtime server ready');
  return io;
}

export async function closeRealtimeServer(io: Server): Promise<void> {
  detachBus();
  await new Promise<void>((resolve) => io.close(() => resolve()));
}
