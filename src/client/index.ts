/**
 * Browser half of the dsh-orchestrator plugin, the cordis-plugin shape the
 * client Loader activates from `lib/client.js`: `inject` names the client
 * services this body consumes, `apply` runs once they exist. Registers the
 * `mesh` dictionary namespace with the locale service, then contributes
 * the `mesh` tab into `conversation.view` — the third roster
 * entry after chat (order 0) and trajectory (order 10), the ui-chat /
 * ui-trajectory precedent: slots.inject waits for the slot's declaration,
 * so load order against ui-conversation needs no coordination.
 *
 * Client-service types are re-declared locally (the DSH client packages are
 * not resolvable from this third-party tree — every real interaction goes
 * through the runtime ctx, and the browser half value-imports nothing
 * outside this package: react is a baseline external and the clipboard
 * helper lives in HarnessPanel).
 */
import type { EventWindowSource } from './harness-fold.ts'
import { HarnessView } from './HarnessAction.tsx'
import { en, NS, zh, type HarnessKey } from './locales.ts'

/** Locale service face: dictionaries and the namespace-bound translate. */
interface LocaleServiceFace {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  /** Stable per-namespace translate reading the active locale at call time. */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
}

/** Slots service face: the declaration-waiting inject plus the register API. */
interface SlotsServiceFace {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
}

/** Session Controller service face: the binding resolver this panel reads. */
interface SessionsServiceFace {
  binding(sessionId: string): { readonly eventSource: EventWindowSource } | undefined
}

/** Client context face consumed by this plugin body (services from ctx only). */
export interface ClientContextFace {
  effect(setup: () => unknown, label?: string): unknown
  readonly locale: LocaleServiceFace
  readonly slots: SlotsServiceFace
  readonly sessions: SessionsServiceFace
}

/** Required client services: session bindings, the slot registry, and locale. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries, then the view tab.
 * @param ctx - client root context carrying the locale, slots, and sessions services.
 */
export function apply(ctx: ClientContextFace): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-orchestrator: dictionaries')

  // Registration-time text (the tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration (the ui-trajectory precedent).
  const t = ctx.locale.bind(NS)
  const label = (): string => t('view.mesh' satisfies HarnessKey)

  const actions = {
    eventSourceOf: (sessionId: string): EventWindowSource | undefined =>
      ctx.sessions.binding(sessionId)?.eventSource,
  }

  ctx.slots.inject(
    'conversation.view',
    () => ctx.slots.register({
      name: 'conversation.view',
      id: 'mesh',
      order: 20,
      label,
      locale: NS,
      inject: () => actions,
    }, HarnessView),
  )
}
