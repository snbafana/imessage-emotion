'use client'

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { trpc } from '../lib/trpc/client'
import { ChevronIcon, SendIcon, SparkleIcon } from './icons'

type Turn = {
  id: string
  role: 'user' | 'agent'
  text: string
  status?: 'submitted' | 'done' | 'error'
  citations?: Array<{ label: string }>
}

type ChatPanelProps = {
  conversationId?: number
  runId?: number
  windowId?: number | null
  label?: string
}

export default function ChatPanel({
  conversationId,
  runId,
  windowId = null,
  label = 'selected run',
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [isAsking, setIsAsking] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const trimmedDraft = draft.trim()
  const isOverMaxLength = trimmedDraft.length > 1000

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, isAsking])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const submitQuestion = useCallback(async () => {
    const question = draft.trim()
    if (!question || isAsking || isOverMaxLength) return

    setDraft('')
    const questionId = `user-${Date.now()}`
    setTurns((current) => [
      ...current,
      { id: questionId, role: 'user', text: question, status: 'submitted' },
    ])
    if (conversationId === undefined || runId === undefined || windowId === null) {
      setTurns((current) => [
        ...current.map((turn) =>
          turn.id === questionId ? { ...turn, status: 'done' as const } : turn,
        ),
        {
          id: `agent-${Date.now()}`,
          role: 'agent',
          status: 'error',
          text: 'Select a conversation, analysis run, and window before asking about the timeline.',
        },
      ])
      return
    }
    const selectedWindowId = windowId

    setIsAsking(true)
    try {
      const response = await trpc.askConversation.mutate({
        conversationId,
        runId,
        windowId: selectedWindowId,
        question,
      })
      setTurns((current) => [
        ...current.map((turn) =>
          turn.id === questionId ? { ...turn, status: 'done' as const } : turn,
        ),
        {
          id: `agent-${Date.now()}`,
          role: 'agent',
          status: 'done',
          text: response.answer,
          citations: response.citations?.map((citation) => ({ label: citation.label })),
        },
      ])
    } catch (error) {
      setTurns((current) => [
        ...current.map((turn) =>
          turn.id === questionId ? { ...turn, status: 'done' as const } : turn,
        ),
        {
          id: `agent-${Date.now()}`,
          role: 'agent',
          status: 'error',
          text: error instanceof Error ? error.message : 'Chat request failed.',
        },
      ])
    } finally {
      setIsAsking(false)
    }
  }, [conversationId, draft, isAsking, isOverMaxLength, runId, windowId])

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void submitQuestion()
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitQuestion()
    }
  }

  return (
    <section className="panel chat-panel">
      <div className="chat-head">
        <SparkleIcon />
        <span className="t">Ask the timeline</span>
        <span className="meta">{label}</span>
      </div>

      <div className="chat-body" ref={bodyRef} role="log">
        {turns.length === 0 && (
          <div className="turn agent">
            <div className="text">No questions in this window yet.</div>
          </div>
        )}
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="turn user" data-status={turn.status}>
              <div className="bubble">{turn.text}</div>
            </div>
          ) : (
            <div key={turn.id} className="turn agent" data-status={turn.status}>
              <div className="text">{turn.text}</div>
              {turn.citations?.map((citation) => (
                <button key={citation.label} className="citation">
                  <span className="dot" />
                  <span className="c-label">{citation.label}</span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          ),
        )}
        {isAsking && (
          <div className="turn agent pending" role="status">
            <div className="text">Reading the selected window...</div>
          </div>
        )}
      </div>

      <form className="input-bar" onSubmit={ask}>
        <div className="field">
          <textarea
            placeholder="Ask about this conversation window..."
            aria-label="Ask the timeline"
            disabled={isAsking}
            maxLength={1000}
            onKeyDown={submitOnEnter}
            ref={textareaRef}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className={isOverMaxLength ? 'char-count over' : 'char-count'}>
            {trimmedDraft.length}/1000
          </span>
        </div>
        <Button
          className="send"
          aria-label="Send"
          type="submit"
          disabled={!trimmedDraft || isAsking || isOverMaxLength}
        >
          <SendIcon />
        </Button>
      </form>
    </section>
  )
}
