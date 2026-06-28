'use client'

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import type {
  EveMessageData,
  EveMessagePart,
  UseEveAgentHelpers,
} from 'eve/react'
import type { HandleMessageStreamEvent } from 'eve/client'
import { CollapseIcon, ExpandIcon, SendIcon } from './icons'

type ChatPanelProps = {
  agent: UseEveAgentHelpers<EveMessageData>
  conversationId?: number
  runId?: number
  windowId?: number | null
  label?: string
}

type Scope = 'whole' | 'window'
type ActivityTone = 'neutral' | 'ok' | 'error'
type ActivityItem = {
  key: string
  label: string
  detail?: string
  tone: ActivityTone
}
type ActionRequest = Extract<HandleMessageStreamEvent, { type: 'actions.requested' }>['data']['actions'][number]
type ActionResult = Extract<HandleMessageStreamEvent, { type: 'action.result' }>['data']['result']
type DynamicToolPart = Extract<EveMessagePart, { type: 'dynamic-tool' }>
type AuthorizationPart = Extract<EveMessagePart, { type: 'authorization' }>
type ToolTone = 'active' | 'ok' | 'error' | 'waiting'

function toolStateMeta(state: DynamicToolPart['state']): { label: string; tone: ToolTone } {
  if (state === 'output-available') return { label: 'done', tone: 'ok' }
  if (state === 'output-error') return { label: 'failed', tone: 'error' }
  if (state === 'output-denied') return { label: 'denied', tone: 'error' }
  if (state === 'approval-requested') return { label: 'needs approval', tone: 'waiting' }
  if (state === 'approval-responded') return { label: 'approved', tone: 'active' }
  if (state === 'input-available') return { label: 'queued', tone: 'active' }
  return { label: 'preparing', tone: 'active' }
}

function actionName(action: ActionRequest): string {
  if (action.kind === 'tool-call') return action.toolName
  if (action.kind === 'load-skill') return 'load_skill'
  if (action.kind === 'subagent-call') return action.subagentName
  return action.remoteAgentName
}

function resultName(result: ActionResult): string {
  if (result.kind === 'tool-result') return result.toolName
  if (result.kind === 'load-skill-result') return result.name ?? 'load_skill'
  return result.subagentName
}

function compactValue(value: unknown, limit = 220): string | undefined {
  if (value == null) return undefined
  let text: string | undefined
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (!text) return undefined
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
}

function eventActivity(event: HandleMessageStreamEvent, index: number): ActivityItem | null {
  const key = `${event.type}-${event.meta?.at ?? index}`
  if (event.type === 'turn.started') {
    return { key, label: 'turn started', detail: event.data.turnId, tone: 'neutral' }
  }
  if (event.type === 'step.started') {
    return { key, label: 'thinking', detail: `step ${event.data.stepIndex + 1}`, tone: 'neutral' }
  }
  if (event.type === 'actions.requested') {
    return {
      key,
      label: 'tool requested',
      detail: event.data.actions.map(actionName).join(', '),
      tone: 'neutral',
    }
  }
  if (event.type === 'action.result') {
    return {
      key,
      label: event.data.status === 'completed' ? 'tool completed' : 'tool failed',
      detail: [resultName(event.data.result), event.data.error?.message ?? compactValue(event.data.result.output)]
        .filter(Boolean)
        .join(' · '),
      tone: event.data.status === 'completed' ? 'ok' : 'error',
    }
  }
  if (event.type === 'message.completed' && event.data.message) {
    return { key, label: 'answer ready', detail: event.data.finishReason, tone: 'ok' }
  }
  if (event.type === 'step.failed' || event.type === 'turn.failed' || event.type === 'session.failed') {
    return { key, label: 'eve error', detail: event.data.message, tone: 'error' }
  }
  return null
}

function toolDisplayName(part: DynamicToolPart): string {
  return part.toolMetadata?.eve?.name ?? part.toolName
}

function toolKind(part: DynamicToolPart): string {
  return part.toolMetadata?.eve?.kind?.replace(/-/g, ' ') ?? 'tool call'
}

function renderReasoning(part: Extract<EveMessagePart, { type: 'reasoning' }>, key: number) {
  const text = part.text.trim()
  if (!text) {
    return (
      <div key={key} className="reasoning-step">
        thinking
      </div>
    )
  }
  return (
    <details key={key} className="reasoning-card">
      <summary>
        <span>Reasoning</span>
        <span>{part.state === 'streaming' ? 'streaming' : 'complete'}</span>
      </summary>
      <div className="reasoning-text">{text}</div>
    </details>
  )
}

function renderAuthorization(part: AuthorizationPart, key: number) {
  const tone = part.state === 'completed' ? 'ok' : 'waiting'
  return (
    <div key={key} className={`tool-card tone-${tone}`}>
      <div className="tool-summary">
        <span className="tool-status-dot" aria-hidden />
        <span className="tool-main">
          <span className="tool-name">{part.displayName}</span>
          <span className="tool-kind">{part.description}</span>
        </span>
        <span className="tool-state">{part.state}</span>
      </div>
    </div>
  )
}

function renderTool(part: DynamicToolPart, key: number) {
  const meta = toolStateMeta(part.state)
  const input = compactValue(part.input, 420)
  const output = part.state === 'output-available' ? compactValue(part.output, 420) : undefined
  const error = part.state === 'output-error' ? part.errorText : undefined
  const shouldOpen = part.state === 'output-error' || part.state === 'output-denied'

  return (
    <details key={key} className={`tool-card tone-${meta.tone}`} open={shouldOpen}>
      <summary className="tool-summary">
        <span className="tool-status-dot" aria-hidden />
        <span className="tool-main">
          <span className="tool-name">{toolDisplayName(part)}</span>
          <span className="tool-kind">{toolKind(part)}</span>
        </span>
        <span className="tool-state">{meta.label}</span>
      </summary>
      {(input || output || error) && (
        <div className="tool-body">
          {input && (
            <div className="tool-detail">
              <span>input</span>
              <code>{input}</code>
            </div>
          )}
          {output && (
            <div className="tool-detail">
              <span>output</span>
              <code>{output}</code>
            </div>
          )}
          {error && (
            <div className="tool-detail error">
              <span>error</span>
              <code>{error}</code>
            </div>
          )}
        </div>
      )}
    </details>
  )
}

function renderPart(part: EveMessagePart, key: number) {
  if (part.type === 'text') {
    return (
      <div key={key} className={`text${part.state === 'streaming' ? ' streaming' : ''}`}>
        {part.text}
      </div>
    )
  }
  if (part.type === 'reasoning') return renderReasoning(part, key)
  if (part.type === 'authorization') return renderAuthorization(part, key)
  if (part.type === 'dynamic-tool') return renderTool(part, key)
  return null
}

export default function ChatPanel({ agent, conversationId, runId, windowId = null, label = 'this run' }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<Scope>(windowId != null ? 'window' : 'whole')
  const [expanded, setExpanded] = useState(false)

  const busy = agent.status === 'submitted' || agent.status === 'streaming'
  const hasStreamingMessage = agent.data.messages.some((message) =>
    message.parts.some((part) => 'state' in part && part.state === 'streaming'),
  )
  const activity = useMemo(
    () => agent.events.map(eventActivity).filter((item): item is ActivityItem => item != null).slice(-8),
    [agent.events],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [agent.data.messages, agent.status, activity.length])

  useEffect(() => {
    if (!expanded) return
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  async function sendDraft() {
    const question = draft.trim()
    if (!question || busy) return
    if (agent.status === 'error') agent.reset()
    setDraft('')
    await agent.send({
      message: question,
      clientContext: {
        scope,
        conversationId: conversationId ?? null,
        runId: runId ?? null,
        windowId: scope === 'window' ? windowId : null,
      },
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void sendDraft()
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void sendDraft()
  }

  return (
    <>
      {expanded && (
        <button
          className="chat-backdrop"
          type="button"
          aria-label="Close expanded chat"
          onClick={() => setExpanded(false)}
        />
      )}
      <section className={`panel chat-panel${expanded ? ' expanded' : ''}`}>
      <div className="chat-head">
        <div className="chat-title">
          <span className="t">Ask the timeline</span>
          <span className="meta">{expanded ? 'expanded workspace' : label}</span>
        </div>
        <span className={`eve-badge${busy ? ' busy' : ''}`}>eve agent{busy ? ' · thinking' : ''}</span>
        <Button
          className="chat-icon-button"
          type="button"
          aria-label={expanded ? 'Collapse chat' : 'Expand chat'}
          title={expanded ? 'Collapse chat' : 'Expand chat'}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <CollapseIcon /> : <ExpandIcon />}
        </Button>
      </div>

      <div className="scope-switcher">
        <Button
          className={`scope-option${scope === 'whole' ? ' active' : ''}`}
          onClick={() => setScope('whole')}
        >
          <span className="scope-title">Whole timeline</span>
          <span className="scope-sub">all windows in {label}</span>
        </Button>
        <Button
          className={`scope-option${scope === 'window' ? ' active' : ''}`}
          onClick={() => setScope('window')}
          disabled={windowId == null}
        >
          <span className="scope-title">This window</span>
          <span className="scope-sub">{windowId == null ? 'select a window' : `window #${windowId}`}</span>
        </Button>
      </div>

      <div className="chat-body">
        {agent.data.messages.map((message, mi) =>
          message.role === 'user' ? (
            <div key={mi} className="turn user">
              <div className="bubble">{message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</div>
            </div>
          ) : (
            <div key={mi} className="turn agent">
              {message.parts.map(renderPart)}
            </div>
          ),
        )}

        {agent.status === 'error' && (
          <div className="chat-error">{agent.error?.message ?? 'The agent hit an error. Is the eve service running?'}</div>
        )}

        {busy && !hasStreamingMessage && (
          <div className="turn agent pending">
            <div className="streaming-pill">
              <span aria-hidden />
              <span>thinking</span>
            </div>
          </div>
        )}
        {activity.length > 0 && (
          <details className="stream-trace" open={busy}>
            <summary>
              <span>Live trace</span>
              <span>{busy ? 'running' : `${activity.length} recent`}</span>
            </summary>
            <div className="activity-log" aria-label="Eve activity">
              {activity.map((item) => (
                <div key={item.key} className={`activity-row tone-${item.tone}`}>
                  <span className="activity-label">{item.label}</span>
                  {item.detail && <span className="activity-detail">{item.detail}</span>}
                </div>
              ))}
            </div>
          </details>
        )}
        <div ref={endRef} />
      </div>

      <form className="input-bar" onSubmit={submit}>
        <div className="field">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={submitOnEnter}
            placeholder={scope === 'window' && windowId != null ? `Ask about window #${windowId}...` : 'Ask about the whole timeline...'}
            aria-label="Ask the timeline"
            rows={2}
          />
        </div>
        <Button className="send" type="submit" aria-label="Send" disabled={busy}>
          <SendIcon />
        </Button>
      </form>
      </section>
    </>
  )
}
