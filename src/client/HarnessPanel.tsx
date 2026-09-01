/**
 * The mesh panel view body, a 1:1 translation of the reviewed design mock
 * (index-2.html): plugin header, then — dynamic data first, static
 * reference last — mesh members, templates, and the collapsed feature
 * docs. Only `.panel` and its internals are translated; the mock's stage /
 * frame / tabbar scaffold belongs to the real app. Class names follow the
 * mock verbatim, with every stylesheet rule scoped under the `.dsh-mesh`
 * root so the injected <style> cannot leak into the host page. Extended
 * mock tokens (bg-layer-0, radius/space/motion/font scales,
 * business-primary-weak) are not referenced as var(): literals or
 * color-mix over the real tokens stand in, every var() names a token the
 * app actually ships.
 */
import { useCallback, useRef, useState } from 'react'
import type { HarnessEntry, HarnessState } from '../harness.ts'
import { clip } from '../text.ts'
import type { MeshMember } from './harness-fold.ts'
import type { TranslateHarness } from './locales.ts'

/** Content-summary cap for one template card. */
const SUMMARY_CHARS = 120

/** Displayed plugin version (kept in step with package.json by hand). */
const PLUGIN_VERSION = 'v0.3'

/** Copy-feedback dwell time (the mock's 1.2s). */
const COPY_FLASH_MS = 1200

/** The eight orchestration tools, in overview order. */
const TOOLS = [
  'agent_spawn', 'agent_send', 'agent_broadcast', 'agent_interrupt',
  'agent_list', 'agent_trace', 'agent_harness', 'agent_schedule',
] as const

/** Entries of one state in display order (kind order, then id). */
function sortedEntries(state: HarnessState): readonly HarnessEntry[] {
  const order: readonly HarnessEntry['kind'][] = ['worker', 'memory', 'prompt']
  return Object.values(state.entries).sort((a, b) => {
    const rank = order.indexOf(a.kind) - order.indexOf(b.kind)
    return rank !== 0 ? rank : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

/** Shorten a session-scoped id for display (full value in the title). */
function abbreviateId(id: string): string {
  const bare = id.replace(/^session-/, '')
  return bare.length <= 8 ? bare : `${bare.slice(0, 8)}…`
}

/** Progress of the one-shot global-state fetch. */
export type GlobalLoadState = 'idle' | 'loading' | 'ready' | 'error'

/** Props of the view body. */
export interface HarnessPanelProps {
  readonly t: TranslateHarness
  /** Session-local harness state folded from the event window. */
  readonly local: HarnessState
  /** Whether the event window still has unloaded older history. */
  readonly localHasMore: boolean
  /** Global state last fetched from the host route; null before the first success. */
  readonly globalState: HarnessState | null
  /** Current fetch progress for the global section. */
  readonly globalLoad: GlobalLoadState
  /** Workers this session spawned, in spawn order. */
  readonly members: readonly MeshMember[]
  readonly onRefreshGlobal: () => void
}

/** Copy feedback shared by the id chip and the template copy button. */
function useCopyFlash(): {
  readonly outcome: 'ok' | 'fail' | null
  readonly flash: (text: string) => void
} {
  const [outcome, setOutcome] = useState<'ok' | 'fail' | null>(null)
  const flash = useCallback((text: string): void => {
    void writeClipboard(text).then((ok) => {
      setOutcome(ok ? 'ok' : 'fail')
      window.setTimeout(() => { setOutcome(null) }, COPY_FLASH_MS)
    })
  }, [])
  return { outcome, flash }
}

/** The member id chip: click copies the full child id, flashes ✓. */
function IdChip({ id, t }: { readonly id: string; readonly t: TranslateHarness }) {
  const { outcome, flash } = useCopyFlash()
  return (
    <button
      type="button"
      className={outcome === null ? 'idchip' : 'idchip is-done'}
      data-outcome={outcome ?? undefined}
      title={t('copyIdTitle')}
      onClick={() => { flash(id) }}
    >
      {outcome === null ? abbreviateId(id) : '✓'}
    </button>
  )
}

/** The template copy button: click copies the id, flashes ✓ 已复制. */
function CopyButton({ id, t }: { readonly id: string; readonly t: TranslateHarness }) {
  const { outcome, flash } = useCopyFlash()
  return (
    <button
      type="button"
      className={outcome === null ? 'copybtn' : 'copybtn is-done'}
      data-outcome={outcome ?? undefined}
      title={id}
      onClick={() => { flash(id) }}
    >
      {outcome === 'ok' ? `✓ ${t('copied')}` : outcome === 'fail' ? t('copyFailed') : t('copyId')}
    </button>
  )
}

/** Route badges row: provider/model/maxTokens plain, effort in the warn variant. */
function RouteBadges({ provider, model, maxTokens, effort }: {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  readonly effort?: string
}) {
  if (provider === undefined && model === undefined && maxTokens === undefined && effort === undefined) {
    return null
  }
  return (
    <div className="member__badges">
      {provider !== undefined && <span className="badge">{provider}</span>}
      {model !== undefined && <span className="badge">{model}</span>}
      {maxTokens !== undefined && <span className="badge">{maxTokens}</span>}
      {effort !== undefined && <span className="badge badge--warn">{`effort: ${effort}`}</span>}
    </div>
  )
}

/** One mesh member card. The dot is static spawn provenance — never liveness. */
function MemberCard({ member, order, t }: {
  readonly member: MeshMember
  readonly order: number
  readonly t: TranslateHarness
}) {
  return (
    <li className="card member">
      <span className="member__dot" title={t('member.spawned')} />
      <div className="member__main">
        <div className="member__row">
          <span className="member__name">{member.label ?? abbreviateId(member.childId)}</span>
          <span className="member__num">{`#${order}`}</span>
          <IdChip id={member.childId} t={t} />
        </div>
        <RouteBadges
          provider={member.provider}
          model={member.model}
          maxTokens={member.maxTokens}
          effort={member.effort}
        />
      </div>
    </li>
  )
}

/** One template card: mono id name, version, kind badge, copy, summary. */
function TemplateCard({ entry, t, global }: {
  readonly entry: HarnessEntry
  readonly t: TranslateHarness
  readonly global: boolean
}) {
  return (
    <li className="card tpl">
      <div className="tpl__row">
        <span className="tpl__name">{entry.id}</span>
        <span className="tpl__ver">{`v${entry.version}`}</span>
        <span className="badge">{t(`kind.${entry.kind}`)}</span>
        {global && <span className="badge badge--accent">{t('badge.global')}</span>}
        <span className="tpl__actions">
          <CopyButton id={entry.id} t={t} />
        </span>
      </div>
      <p className="tpl__sum">{clip(entry.content.replace(/\s+/g, ' ').trim(), SUMMARY_CHARS)}</p>
    </li>
  )
}

/** The dashed "[ ]" empty block with its jump-to-docs action. */
function EmptyBlock({ t, onOpenDocs }: {
  readonly t: TranslateHarness
  readonly onOpenDocs: () => void
}) {
  return (
    <div className="empty">
      <div className="empty__glyph">[ ]</div>
      <p className="empty__title">{t('empty.title')}</p>
      <p className="empty__hint">{t('empty.hint')}</p>
      <button type="button" className="copybtn empty__action" onClick={onOpenDocs}>
        {t('empty.docs')}
      </button>
    </div>
  )
}

/** The collapsed-by-border docs fold: eight tool rows plus the protocol. */
function DocsSection({ t, open, onToggle, toggleRef }: {
  readonly t: TranslateHarness
  readonly open: boolean
  readonly onToggle: () => void
  readonly toggleRef: (node: HTMLButtonElement | null) => void
}) {
  return (
    <section className="sect" aria-labelledby="dsh-mesh-t-docs">
      <div className="docs">
        <button
          ref={toggleRef}
          type="button"
          className="docs__toggle"
          aria-expanded={open}
          aria-controls="dsh-mesh-docs-body"
          onClick={onToggle}
        >
          <svg
            className="docs__chevron"
            width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M4 2.5 8 6l-4 3.5" />
          </svg>
          <span className="docs__title" id="dsh-mesh-t-docs">{t('section.features')}</span>
          <span className="docs__meta">{t('docs.meta')}</span>
        </button>
        <div className="docs__body" id="dsh-mesh-docs-body" hidden={!open}>
          {TOOLS.map(name => (
            <div className="tool" key={name}>
              <span className="tool__name">{name}</span>
              <span className="tool__desc">{t(`tool.${name}`)}</span>
            </div>
          ))}
          <div className="proto">
            <p className="proto__title">{t('protocol.title')}</p>
            <ol className="proto__list">
              <li>{t('protocol.turns')}</li>
              <li>{t('protocol.report')}</li>
              <li>{t('protocol.lead')}</li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}

/** The mesh panel rendered inside the conversation view area. */
export function HarnessPanel({
  t, local, localHasMore, globalState, globalLoad, members, onRefreshGlobal,
}: HarnessPanelProps) {
  const [docsOpen, setDocsOpen] = useState(false)
  const docsToggleRef = useRef<HTMLButtonElement | null>(null)
  const openDocs = useCallback((): void => {
    setDocsOpen(true)
    docsToggleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const localEntries = sortedEntries(local)
  const globalEntries = globalState === null ? null : sortedEntries(globalState)
  const templateEmpty = localEntries.length === 0
    && globalState !== null
    && Object.keys(globalState.entries).length === 0
  const globalNotice = globalState === null
    ? (globalLoad === 'loading' || globalLoad === 'idle' ? t('loading') : t('loadFailed'))
    : null
  return (
    <div className="panel dsh-mesh" data-mesh-view>
      <div className="panel__head">
        <div className="panel__titlerow">
          <h1 className="panel__name">dsh-orchestrator</h1>
          <span className="badge badge--accent">{PLUGIN_VERSION}</span>
        </div>
        <p className="panel__tagline">{t('header.tagline')}</p>
      </div>
      <div className="panel__scroll">
        <section className="sect" aria-labelledby="dsh-mesh-t-members">
          <div className="sect__head">
            <h2 className="sect__title" id="dsh-mesh-t-members">{t('section.members')}</h2>
            <span className="count">{members.length}</span>
          </div>
          {members.length === 0
            ? (
              <div className="empty">
                <div className="empty__glyph">[ ]</div>
                <p className="empty__title">{t('members.empty')}</p>
              </div>
            )
            : (
              <ul className="list">
                {members.map((member, index) => (
                  <MemberCard key={member.childId} member={member} order={index + 1} t={t} />
                ))}
              </ul>
            )}
          <p className="footnote">
            {t('members.footnoteBefore')}
            {' '}
            <code>agent_list</code>
            {t('members.footnoteAfter') === '' ? '' : ` ${t('members.footnoteAfter')}`}
          </p>
        </section>

        <section className="sect" aria-labelledby="dsh-mesh-t-tpl">
          <div className="sect__head">
            <h2 className="sect__title" id="dsh-mesh-t-tpl">{t('section.templates')}</h2>
          </div>
          {templateEmpty
            ? <EmptyBlock t={t} onOpenDocs={openDocs} />
            : (
              <>
                <div className="subsect">
                  <div className="subsect__head">
                    <h3 className="subsect__title">{t('localSection')}</h3>
                    <span className="count">{localEntries.length}</span>
                  </div>
                  <ul className="list">
                    {localEntries.map(entry => <TemplateCard key={entry.id} entry={entry} t={t} global={false} />)}
                  </ul>
                  {localHasMore && (
                    <div className="hintrow">
                      <span className="mono">···</span>
                      {t('olderNotLoaded')}
                    </div>
                  )}
                </div>
                <div className="subsect">
                  <div className="subsect__head">
                    <h3 className="subsect__title">{t('globalSection')}</h3>
                    <span className="count">{globalEntries?.length ?? 0}</span>
                    <div className="sect__aside">
                      <button
                        type="button"
                        className={globalLoad === 'loading' ? 'iconbtn is-spinning' : 'iconbtn'}
                        aria-label={t('refreshGlobal')}
                        title={t('refreshGlobal')}
                        onClick={onRefreshGlobal}
                      >
                        <svg
                          width="13" height="13" viewBox="0 0 16 16" fill="none"
                          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                        >
                          <path d="M13.6 8a5.6 5.6 0 1 1-1.64-3.96" />
                          <path d="M13.8 1.8v3h-3" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {globalNotice !== null
                    ? <div className="hintrow"><span className="mono">···</span>{globalNotice}</div>
                    : (
                      <ul className="list">
                        {globalEntries?.map(entry => (
                          <TemplateCard key={entry.id} entry={entry} t={t} global />
                        ))}
                      </ul>
                    )}
                </div>
              </>
            )}
        </section>

        <DocsSection
          t={t}
          open={docsOpen}
          onToggle={() => { setDocsOpen(value => !value) }}
          toggleRef={(node) => { docsToggleRef.current = node }}
        />
      </div>
    </div>
  )
}

/**
 * Write text to the host clipboard: the async Clipboard API when present,
 * with an `execCommand('copy')` fallback for hosts that omit it (jsdom,
 * insecure contexts) — the same shape as the shared ui-primitives helper,
 * kept local so this bundle needs no non-baseline module rows.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false // denied permission or iframe policy — do not claim success
    }
  }
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
}

/**
 * The panel stylesheet, injected once per document: the mock's CSS with
 * every selector scoped under `.dsh-mesh`. Real app tokens keep their
 * var() (with rgba/light-dark fallbacks); the mock's extended tokens
 * collapse to literals (radius 6/8/10px, .12s ease, mono stack) or
 * color-mix over real tokens (the business-primary-weak accent wash).
 */
const STYLE_TAG = 'dsh-orchestrator/mesh-panel.css'
const MONO_FONT = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace'
const HOVER_MOTION = '.12s ease'
const VIEW_CSS = `
/* base (scoped): button reset + code styling, per the mock */
.dsh-mesh{font-size:13px;line-height:1.5}
.dsh-mesh button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.dsh-mesh button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3d6ee0);outline-offset:1px;border-radius:6px}
.dsh-mesh code{font-family:${MONO_FONT};font-size:.92em;background:var(--dsw-alias-markdown-code-block,#f3f4f7);border-radius:6px;padding:0 4px;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .mono{font-family:${MONO_FONT}}

/* panel shell: full-height flex column + scrolling body */
.dsh-mesh.panel{flex:1;min-height:0;display:flex;flex-direction:column;height:100%;background:var(--dsw-alias-bg-layer-1,light-dark(#fff,#232323));color:var(--dsw-alias-label-primary,light-dark(#171b22,#e3e6ec))}
.dsh-mesh .panel__head{flex:none;padding:16px 20px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e7e9ee)}
.dsh-mesh .panel__titlerow{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-mesh .panel__name{font-family:${MONO_FONT};font-size:14.5px;font-weight:600;margin:0;letter-spacing:-.01em}
.dsh-mesh .panel__tagline{margin:6px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .panel__scroll{flex:1;min-height:0;overflow-y:auto;padding:4px 20px 24px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,#d3d7df) transparent}
.dsh-mesh .panel__scroll::-webkit-scrollbar{width:8px}
.dsh-mesh .panel__scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#d3d7df);border-radius:8px}

/* sections */
.dsh-mesh .sect{margin-top:20px}
.dsh-mesh .sect__head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.dsh-mesh .sect__title{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-mesh .sect__aside{margin-left:auto;display:flex;align-items:center;gap:6px}
.dsh-mesh .count{font-family:${MONO_FONT};font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(16,24,40,.05));color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-mesh .subsect{margin-top:14px}
.dsh-mesh .subsect__head{display:flex;align-items:center;gap:6px;margin:0 0 6px}
.dsh-mesh .subsect__title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#454c57)}

/* lists and cards */
.dsh-mesh .list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dsh-mesh .card{border:1px solid var(--dsw-alias-border-l1,#e7e9ee);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,light-dark(#fff,#232323));transition:border-color ${HOVER_MOTION}}
.dsh-mesh .card:hover{border-color:var(--dsw-alias-border-l2,#d3d7df)}

/* members: the dot marks spawn provenance (static, never liveness) */
.dsh-mesh .member{display:flex;gap:10px;align-items:flex-start}
.dsh-mesh .member__dot{flex:none;width:7px;height:7px;margin-top:6px;border-radius:50%;background:rgba(61,110,224,.4);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3d6ee0) 40%,transparent)}
.dsh-mesh .member__main{flex:1;min-width:0}
.dsh-mesh .member__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-mesh .member__name{font-family:${MONO_FONT};font-size:13px;font-weight:600}
.dsh-mesh .member__num{font-family:${MONO_FONT};font-size:11.5px;color:var(--dsw-alias-label-caption,#99a0ab)}
.dsh-mesh .idchip{font-family:${MONO_FONT};font-size:11px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-markdown-code-block,#f3f4f7);color:var(--dsw-alias-label-tertiary,#6b7280);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color ${HOVER_MOTION},background ${HOVER_MOTION}}
.dsh-mesh button.idchip:hover{color:var(--dsw-alias-label-primary,#171b22)}
.dsh-mesh .idchip.is-done,.dsh-mesh .copybtn.is-done{color:var(--dsw-alias-state-success-primary,#189a68)}
.dsh-mesh .copybtn.is-done[data-outcome=fail]{color:var(--dsw-alias-state-error-primary,#d64545)}
.dsh-mesh .member__badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}

/* badges */
.dsh-mesh .badge{font-family:${MONO_FONT};font-size:11px;line-height:16px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,#d3d7df);border-radius:6px;color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap}
.dsh-mesh .badge--accent{color:var(--dsw-alias-state-business-primary,#3d6ee0);background:rgba(61,110,224,.09);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3d6ee0) 9%,transparent);border-color:transparent}
.dsh-mesh .badge--warn{color:var(--dsw-alias-state-warn-label,#b4650e);border-color:rgba(180,101,14,.35);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b4650e) 35%,transparent)}

/* templates */
.dsh-mesh .tpl__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-mesh .tpl__name{font-family:${MONO_FONT};font-size:13px;font-weight:600}
.dsh-mesh .tpl__ver{font-family:${MONO_FONT};font-size:11px;color:var(--dsw-alias-label-caption,#99a0ab)}
.dsh-mesh .tpl__actions{margin-left:auto;display:flex;gap:6px}
.dsh-mesh .tpl__sum{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .copybtn{font-size:11.5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,#d3d7df);border-radius:6px;color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;transition:background ${HOVER_MOTION},color ${HOVER_MOTION},border-color ${HOVER_MOTION}}
.dsh-mesh .copybtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(16,24,40,.05));color:var(--dsw-alias-label-primary,#171b22)}
.dsh-mesh .copybtn.is-done{border-color:rgba(24,154,104,.4);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#189a68) 40%,transparent)}
.dsh-mesh .hintrow{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;border:1px dashed var(--dsw-alias-border-l1,#e7e9ee);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-caption,#99a0ab)}
.dsh-mesh .hintrow .mono{font-size:11px}

/* empty state */
.dsh-mesh .empty{border:1px dashed var(--dsw-alias-border-l2,#d3d7df);border-radius:8px;padding:26px 16px;text-align:center}
.dsh-mesh .empty__glyph{font-family:${MONO_FONT};font-size:16px;color:var(--dsw-alias-label-caption,#99a0ab)}
.dsh-mesh .empty__title{margin:6px 0 0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .empty__hint{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-caption,#99a0ab)}
.dsh-mesh .empty__action{margin-top:10px}

/* icon buttons (refresh) */
.dsh-mesh .iconbtn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:var(--dsw-alias-label-tertiary,#6b7280);transition:background ${HOVER_MOTION},color ${HOVER_MOTION}}
.dsh-mesh .iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(16,24,40,.05));color:var(--dsw-alias-label-primary,#171b22)}
.dsh-mesh .iconbtn svg{display:block}
.dsh-mesh .iconbtn.is-spinning svg{animation:dsh-mesh-spin .8s linear infinite}
@keyframes dsh-mesh-spin{to{transform:rotate(360deg)}}

/* docs fold */
.dsh-mesh .docs{border:1px solid var(--dsw-alias-border-l1,#e7e9ee);border-radius:8px;overflow:hidden}
.dsh-mesh .docs__toggle{width:100%;display:flex;align-items:center;gap:8px;padding:9px 12px;text-align:left;transition:background ${HOVER_MOTION}}
.dsh-mesh .docs__toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(16,24,40,.05))}
.dsh-mesh .docs__chevron{flex:none;color:var(--dsw-alias-label-caption,#99a0ab);transition:transform ${HOVER_MOTION}}
.dsh-mesh .docs__toggle[aria-expanded="true"] .docs__chevron{transform:rotate(90deg)}
.dsh-mesh .docs__title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .docs__meta{margin-left:auto;font-family:${MONO_FONT};font-size:11px;color:var(--dsw-alias-label-caption,#99a0ab);white-space:nowrap}
.dsh-mesh .docs__body{border-top:1px solid var(--dsw-alias-border-l1,#e7e9ee);padding:2px 12px 12px}
.dsh-mesh .tool{display:grid;grid-template-columns:minmax(140px,max-content) 1fr;gap:4px 14px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#e7e9ee)}
.dsh-mesh .tool:last-of-type{border-bottom:0}
.dsh-mesh .tool__name{font-family:${MONO_FONT};font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary,#171b22)}
.dsh-mesh .tool__desc{font-size:12px;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .proto{margin-top:10px;padding:10px 12px;border-radius:6px;background:var(--dsw-alias-markdown-code-block,#f3f4f7)}
.dsh-mesh .proto__title{margin:0 0 6px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-mesh .proto__list{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary,#454c57)}
.dsh-mesh .proto__list li+li{margin-top:3px}

/* footnote */
.dsh-mesh .footnote{margin:8px 0 0;font-size:11.5px;color:var(--dsw-alias-label-caption,#99a0ab)}

/* narrow breakpoint: the tool grid collapses to one column */
@media (max-width:520px){
  .dsh-mesh .tool{grid-template-columns:1fr}
  .dsh-mesh .panel__head,.dsh-mesh .panel__scroll{padding-left:14px;padding-right:14px}
}
@media (prefers-reduced-motion:reduce){
  .dsh-mesh *,.dsh-mesh *::before,.dsh-mesh *::after{animation:none!important;transition:none!important}
}
`

if (typeof document !== 'undefined'
  && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-orchestrator'
  tag.dataset.pluginCss = STYLE_TAG
  tag.textContent = VIEW_CSS
  document.head.appendChild(tag)
}
