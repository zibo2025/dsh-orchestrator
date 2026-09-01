/**
 * The conversation-view tab body (registered as the `mesh` entry of the
 * `conversation.view` roster, after chat and trajectory). The session-local
 * halves subscribe to the binding's event window through
 * useSyncExternalStore and fold live — a new agent_harness or agent_spawn
 * tool/result republishes the window, so the open tab updates without any
 * refresh action; the global half is fetched once whenever the tab mounts
 * idle plus a manual refresh button. ConvViewOwnerProps
 * (viewRequest/openView) are unused — this view has no focus addresses.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HarnessState } from '../harness.ts'
import {
  EMPTY_EVENT_WINDOW, globalHarnessStateOf, localHarnessStateOf, meshMembersOf,
  type EventWindowSource,
} from './harness-fold.ts'
import type { TranslateHarness } from './locales.ts'
import { HarnessPanel, type GlobalLoadState } from './HarnessPanel.tsx'

/** Host route serving the global harness state (read-only, no auth). */
const GLOBAL_STATE_URL = '/plugins/orchestrator/harness.json'

/** The inject face the plugin body binds to this entry. */
export interface HarnessViewInjected {
  /** The event-window source of one session binding, when it is live. */
  eventSourceOf(sessionId: string): EventWindowSource | undefined
}

/** Props of the view tab (session standard kit + inject face + locale seat). */
export interface HarnessViewProps extends HarnessViewInjected {
  readonly sessionId: string
  readonly t: TranslateHarness
}

/** Fetch the global state once, settling into the load-state machine. */
async function fetchGlobalState(): Promise<{ state: HarnessState | null; load: GlobalLoadState }> {
  try {
    const response = await fetch(GLOBAL_STATE_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const state = globalHarnessStateOf(await response.json())
    if (state === undefined) throw new Error('malformed harness state')
    return { state, load: 'ready' }
  } catch {
    return { state: null, load: 'error' }
  }
}

/** The `mesh` conversation view tab body. */
export function HarnessView({ sessionId, t, eventSourceOf }: HarnessViewProps) {
  const [globalState, setGlobalState] = useState<HarnessState | null>(null)
  const [globalLoad, setGlobalLoad] = useState<GlobalLoadState>('idle')

  // Session switch: drop the cached global read; the idle effect below
  // refetches for the newly selected session.
  useEffect(() => {
    setGlobalState(null)
    setGlobalLoad('idle')
  }, [sessionId])

  const source = useMemo(() => eventSourceOf(sessionId), [eventSourceOf, sessionId])
  const subscribe = useCallback(
    (listener: () => void): (() => void) => source?.subscribe(listener) ?? (() => {}),
    [source],
  )
  const getSnapshot = useCallback(
    () => source?.getSnapshot() ?? EMPTY_EVENT_WINDOW,
    [source],
  )
  const eventWindow = useSyncExternalStore(subscribe, getSnapshot)
  const local = useMemo(() => localHarnessStateOf(eventWindow), [eventWindow])
  const members = useMemo(() => meshMembersOf(eventWindow), [eventWindow])
  const localHasMore = eventWindow.hasMore

  const refreshGlobal = useCallback((): void => {
    setGlobalLoad('loading')
    void fetchGlobalState().then((result) => {
      setGlobalLoad(result.load)
      if (result.state !== null) setGlobalState(result.state)
    })
  }, [])

  // The tab mounts when the user selects it (and remounts on session
  // switch): fetch the global state the first time it is seen idle.
  useEffect(() => {
    if (globalLoad === 'idle') refreshGlobal()
  }, [globalLoad, refreshGlobal])

  return (
    <HarnessPanel
      t={t}
      local={local}
      localHasMore={localHasMore}
      globalState={globalState}
      globalLoad={globalLoad}
      members={members}
      onRefreshGlobal={refreshGlobal}
    />
  )
}
