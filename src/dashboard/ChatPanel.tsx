'use client'

import { FormEvent, useState } from 'react'
import { useEveAgent } from 'eve/react'
import { SendIcon, SparkleIcon } from './icons'

type ChatPanelProps = {
  conversationId?: number
  runId?: number
  windowId?: number | null
  label?: string
}

type Scope = 'whole' | 'window'

function toolStateMark(state: string): { mark: string; color: string } {
  if (state === 'output-available') return { mark: '✓', color: '#2E9E8F' }
  if (state === 'output-error' || state === 'output-denied') return { mark: '!', color: '#D6453B' }
  return { mark: '⋯', color: '#9A9AA0' } // input-streaming / input-available / approval-*
}

export default function ChatPanel({ conversationId, runId, windowId = null, label = 'this run' }: ChatPanelProps) {
  const agent = useEveAgent()
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<Scope>(windowId != null ? 'window' : 'whole')

  const busy = agent.status === 'submitted' || agent.status === 'streaming'

  function submit(event: FormEvent) {
    event.preventDefault()
    const question = draft.trim()
    if (!question || busy) return
    setDraft('')
    void agent.send({
      message: question,
      clientContext: {
        scope,
        conversationId: conversationId ?? null,
        runId: runId ?? null,
        windowId: scope === 'window' ? windowId : null,
      },
    })
  }

  return (
    <section className="panel chat-panel">
      <div className="chat-head">
        <SparkleIcon />
        <span className="t">Ask the timeline</span>
        <span className="eve-badge">eve agent{busy ? ' · thinking' : ''}</span>
      </div>

      {/* Scope: whole timeline vs the selected window */}
      <div className="scope-switcher">
        <button
          className={`scope-option${scope === 'whole' ? ' active' : ''}`}
          onClick={() => setScope('whole')}
        >
          <span className="scope-title">Whole timeline</span>
          <span className="scope-sub">all windows in {label}</span>
        </button>
        <button
          className={`scope-option${scope === 'window' ? ' active' : ''}`}
          onClick={() => setScope('window')}
          disabled={windowId == null}
        >
          <span className="scope-title">This window</span>
          <span className="scope-sub">{windowId == null ? 'select a window' : `window #${windowId}`}</span>
        </button>
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
              {message.parts.map((part, pi) => {
                if (part.type === 'text') return <div key={pi} className="text">{part.text}</div>
                if (part.type === 'dynamic-tool') {
                  const { mark, color } = toolStateMark(part.state)
                  return (
                    <div key={pi} className="tool-row">
                      <span className="tool-mark" style={{ color }}>{mark}</span>
                      <span className="tool-name">{part.toolName}</span>
                      {part.state === 'output-error' && <span className="tool-note">failed</span>}
                    </div>
                  )
                }
                return null
              })}
            </div>
          ),
        )}

        {agent.status === 'error' && (
          <div className="chat-error">{agent.error?.message ?? 'The agent hit an error. Is the eve service running?'}</div>
        )}
      </div>

      <form className="input-bar" onSubmit={submit}>
        <div className="field">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={scope === 'window' && windowId != null ? `Ask about window #${windowId}…` : 'Ask about the whole timeline…'}
            aria-label="Ask the timeline"
          />
        </div>
        <button className="send" type="submit" aria-label="Send" disabled={busy}>
          <SendIcon />
        </button>
      </form>

      <div className="eve-footer">
        <span className="dot" style={{ background: '#2EE6A6' }} />
        durable eve session · streams tool calls · resumes mid-answer
      </div>
    </section>
  )
}
