/**
 * SessionPersistence read helpers spanning DSH 0.1.0-rc (inspect) and
 * 0.1.5+ handle seam (open/stat/read). Prefer the new API when present.
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Duck-typed reader: avoid hard-coding either generation's full Service type. */
export type PersistenceReader = {
  inspect?: (
    id: SessionId,
    signal?: AbortSignal,
  ) => Promise<{ meta: { parentSession?: SessionId }; events: readonly SessionEvent[] }>
  stat?: (
    id: SessionId,
    options?: { signal?: AbortSignal },
  ) => Promise<{ header: { parentSession?: SessionId } } | undefined>
  open?: (
    id: SessionId,
    access: 'read' | 'write',
    options?: { signal?: AbortSignal },
  ) => Promise<{
    header: { parentSession?: SessionId }
    read: (
      offset?: number,
      length?: number,
      options?: { signal?: AbortSignal },
    ) => Promise<{ events: readonly SessionEvent[] }>
    close: () => Promise<void>
  }>
}

/** Durable parentSession: cheap `stat` on 0.1.5+, else legacy `inspect`. */
export async function readPersistedParent(
  persistence: PersistenceReader,
  id: SessionId,
  signal?: AbortSignal,
): Promise<SessionId | undefined> {
  if (typeof persistence.stat === 'function') {
    const snap = await persistence.stat(id, { signal })
    return snap?.header.parentSession
  }
  if (typeof persistence.inspect === 'function') {
    return (await persistence.inspect(id, signal)).meta.parentSession
  }
  return undefined
}

/** Full event log: `open('read')` + `handle.read()` on 0.1.5+, else legacy `inspect`. */
export async function readPersistedEvents(
  persistence: PersistenceReader,
  id: SessionId,
  signal?: AbortSignal,
): Promise<readonly SessionEvent[]> {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(id, 'read', { signal })
    try {
      const { events } = await handle.read(undefined, undefined, { signal })
      return events
    } finally {
      await handle.close()
    }
  }
  if (typeof persistence.inspect === 'function') {
    return (await persistence.inspect(id, signal)).events
  }
  throw new Error('session persistence has neither open nor inspect')
}
