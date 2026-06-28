'use client'

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import type {
  EveMessageData,
  EveMessagePart,
  UseEveAgentHelpers,
} from 'eve/react'
import type { HandleMessageStreamEvent } from 'eve/client'
import { SendIcon, SparkleIcon } from './icons'

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

function toolStateMark(state: string): { mark: string; color: string } {
  if (state === 'output-available') return { mark: '✓', color: '#2E9E8F' }
  if (state === 'output-error' || state === 'output-denied') return { mark: '!', color: '#D6453B' }
  return { mark: '⋯', color: '#9A9AA0' } // input-streaming / input-available / approval-*
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

function compactValue(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
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

function renderPart(part: EveMessagePart, key: number) {
  if (part.type === 'text') return <div key={key} className="text">{part.text}</div>
  if (part.type === 'reasoning') return <div key={key} className="reasoning-step">thinking</div>
  if (part.type === 'authorization') {
    return (
      <div key={key} className="tool-row">
        <span className="tool-mark">!</span>
        <span className="tool-name">{part.displayName}</span>
        <span className="tool-note">{part.state}</span>
      </div>
    )
  }
  if (part.type === 'dynamic-tool') {
    const { mark, color } = toolStateMark(part.state)
    const input = compactValue(part.input)
    const output = part.state === 'output-available' ? compactValue(part.output) : undefined
    return (
      <div key={key} className="tool-card">
        <div className="tool-row">
          <span className="tool-mark" style={{ color }}>{mark}</span>
          <span className="tool-name">{part.toolName}</span>
          <span className={`tool-note state-${part.state}`}>{part.state.replace(/-/g, ' ')}</span>
        </div>
        {input && <div className="tool-detail">input {input}</div>}
        {output && <div className="tool-detail">output {output}</div>}
        {part.state === 'output-error' && <div className="tool-detail error">{part.errorText}</div>}
      </div>
    )
  }
  return null
}

export default function ChatPanel({ agent, conversationId, runId, windowId = null, label = 'this run' }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<Scope>(windowId != null ? 'window' : 'whole')

  const busy = agent.status === 'submitted' || agent.status === 'streaming'
  const activity = useMemo(
    () => agent.events.map(eventActivity).filter((item): item is ActivityItem => item != null).slice(-12),
    [agent.events],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [agent.data.messages, agent.status, activity.length])

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
    <section className="panel chat-panel">
      <div className="chat-head">
        <SparkleIcon />
        <span className="t">Ask the timeline</span>
        <span className="eve-badge">eve agent{busy ? ' · thinking' : ''}</span>
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
        {agent.data.messages.length === 0 && (
          <div className="chat-empty">Ask why a shift happened — eve reads the messages in scope and cites them.</div>
        )}

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

        {busy && (
          <div className="turn agent pending">
            <div className="text">thinking...</div>
          </div>
        )}
        {activity.length > 0 && (
          <div className="activity-log" aria-label="Eve activity">
            {activity.map((item) => (
              <div key={item.key} className={`activity-row tone-${item.tone}`}>
                <span className="activity-label">{item.label}</span>
                {item.detail && <span className="activity-detail">{item.detail}</span>}
              </div>
            ))}
          </div>
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
  )
}
