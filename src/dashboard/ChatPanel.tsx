'use client'

import { FormEvent, KeyboardEvent, ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import type {
  EveMessageInputRequest,
  EveMessagePart,
} from 'eve/react'
import { useEveAgent } from 'eve/react'
import type { HandleMessageStreamEvent, InputResponse } from 'eve/client'
import { CollapseIcon, ExpandIcon, SendIcon } from './icons'
import { useEscapeKey } from './shared/useEscapeKey'

type RespondFn = (response: InputResponse) => void
export type ChatScope = 'whole' | 'window'

export type ChatAutoRequest = {
  id: string
  message: string
  clientContext: {
    scope: ChatScope
    conversationId: number | null
    runId: number | null
    windowId: number | null
  }
}

type ChatPanelProps = {
  conversationId?: number
  runId?: number
  windowId?: number | null
  label?: string
  autoRequest?: ChatAutoRequest | null
  onAutoRequestSent?: (id: string) => void
}

type Scope = ChatScope
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

function recentActivity(events: readonly HandleMessageStreamEvent[]): ActivityItem[] {
  const items: ActivityItem[] = []
  for (let index = events.length - 1; index >= 0 && items.length < 8; index--) {
    const item = eventActivity(events[index], index)
    if (item) items.push(item)
  }
  return items.reverse()
}

function toolDisplayName(part: DynamicToolPart): string {
  return part.toolMetadata?.eve?.name ?? part.toolName
}

function toolKind(part: DynamicToolPart): string {
  return part.toolMetadata?.eve?.kind?.replace(/-/g, ' ') ?? 'tool call'
}

// --- Lightweight, dependency-free Markdown rendering --------------------------
// The eve agent answers in Markdown; we render the common subset it emits
// (headings, bold/italic, inline + fenced code, lists, quotes, links, rules)
// without dangerouslySetInnerHTML — every node is a real React element.

function renderInline(text: string, baseKey = 0): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern =
    /(`[^`]+`)|(\*\*[\s\S]+?\*\*|__[\s\S]+?__)|(\*[^*\n]+?\*|_[^_\n]+?_)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let key = baseKey
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (match[1]) {
      nodes.push(
        <code key={`i${key++}`} className="md-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (match[2]) {
      nodes.push(<strong key={`i${key++}`}>{renderInline(token.slice(2, -2), key * 100)}</strong>)
    } else if (match[3]) {
      nodes.push(<em key={`i${key++}`}>{renderInline(token.slice(1, -1), key * 100)}</em>)
    } else if (match[4]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (link) {
        nodes.push(
          <a key={`i${key++}`} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function renderInlineLines(text: string): ReactNode[] {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`br${idx}`} />)
    out.push(...renderInline(line, idx * 1000))
  })
  return out
}

const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const UL_RE = /^\s*[-*+]\s+/
const OL_RE = /^\s*\d+[.)]\s+/
const QUOTE_RE = /^\s*>\s?/
const FENCE_RE = /^\s*```/

function parseMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (FENCE_RE.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence
      out.push(
        <pre key={key++} className="md-pre">
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    if (HR_RE.test(line)) {
      out.push(<hr key={key++} className="md-hr" />)
      i++
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      out.push(
        <Tag key={key++} className={`md-h md-h${level}`}>
          {renderInline(heading[2].trim())}
        </Tag>,
      )
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE_RE, ''))
        i++
      }
      out.push(
        <blockquote key={key++} className="md-quote">
          {parseMarkdown(buf.join('\n'))}
        </blockquote>,
      )
      continue
    }
    if (UL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(lines[i].replace(UL_RE, ''))
        i++
      }
      out.push(
        <ul key={key++} className="md-ul">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      continue
    }
    if (OL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(lines[i].replace(OL_RE, ''))
        i++
      }
      out.push(
        <ol key={key++} className="md-ol">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      )
      continue
    }
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    out.push(
      <p key={key++} className="md-p">
        {renderInlineLines(buf.join('\n'))}
      </p>,
    )
  }
  return out
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className="md">{blocks}</div>
}

// --- Human-in-the-loop: ask_question / approval prompts -----------------------

function inputResponseSummary(
  request: EveMessageInputRequest,
  response: { optionId?: string; text?: string } | undefined,
): string {
  if (!response) return 'answered'
  if (response.optionId) {
    const option = request.options?.find((opt) => opt.id === response.optionId)
    return option?.label ?? response.optionId
  }
  return response.text ?? 'answered'
}

function QuestionPrompt({
  request,
  onRespond,
}: {
  request: EveMessageInputRequest
  onRespond: RespondFn
}) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const options = request.options ?? []
  const allowText = request.display === 'text' || request.allowFreeform || options.length === 0

  function pick(optionId: string) {
    if (submitted) return
    setSubmitted(true)
    onRespond({ requestId: request.requestId, optionId })
  }

  function sendText() {
    const value = text.trim()
    if (!value || submitted) return
    setSubmitted(true)
    onRespond({ requestId: request.requestId, text: value })
  }

  function onTextKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    sendText()
  }

  return (
    <div className="question-card">
      <div className="question-head">
        <span className="question-dot" aria-hidden />
        <span className="question-label">eve is asking</span>
      </div>
      <div className="question-prompt">
        <Markdown text={request.prompt} />
      </div>
      {options.length > 0 && (
        <div className="question-options">
          {options.map((option) => (
            <Button
              key={option.id}
              className={`question-option style-${option.style ?? 'default'}`}
              type="button"
              disabled={submitted}
              onClick={() => pick(option.id)}
            >
              <span className="qo-label">{option.label}</span>
              {option.description && <span className="qo-desc">{option.description}</span>}
            </Button>
          ))}
        </div>
      )}
      {allowText && (
        <div className="question-freeform">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onTextKey}
            placeholder="Type your answer..."
            aria-label={request.prompt}
            rows={1}
            disabled={submitted}
          />
          <Button
            className="question-send"
            type="button"
            disabled={submitted || !text.trim()}
            onClick={sendText}
          >
            <SendIcon />
          </Button>
        </div>
      )}
    </div>
  )
}

function renderAnsweredQuestion(
  request: EveMessageInputRequest,
  response: { optionId?: string; text?: string } | undefined,
  denied: boolean,
  key: number,
) {
  return (
    <div key={key} className={`question-card answered${denied ? ' denied' : ''}`}>
      <div className="question-head">
        <span className="question-dot" aria-hidden />
        <span className="question-label">{denied ? 'declined' : 'you answered'}</span>
      </div>
      <div className="question-prompt">
        <Markdown text={request.prompt} />
      </div>
      <div className="question-answer">{inputResponseSummary(request, response)}</div>
    </div>
  )
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

function renderTool(part: DynamicToolPart, key: number, onRespond: RespondFn) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest
  const inputResponse = part.toolMetadata?.eve?.inputResponse
  if (inputRequest) {
    if (part.state === 'approval-requested') {
      return <QuestionPrompt key={key} request={inputRequest} onRespond={onRespond} />
    }
    if (part.state === 'approval-responded' || part.state === 'output-available' || part.state === 'output-denied') {
      return renderAnsweredQuestion(inputRequest, inputResponse, part.state === 'output-denied', key)
    }
  }

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

function renderPart(part: EveMessagePart, key: number, onRespond: RespondFn) {
  if (part.type === 'text') {
    return (
      <div key={key} className={`text md-text${part.state === 'streaming' ? ' streaming' : ''}`}>
        <Markdown text={part.text} />
        {part.state === 'streaming' && <span className="md-caret" aria-hidden />}
      </div>
    )
  }
  if (part.type === 'reasoning') return renderReasoning(part, key)
  if (part.type === 'authorization') return renderAuthorization(part, key)
  if (part.type === 'dynamic-tool') return renderTool(part, key, onRespond)
  if (part.type === 'step-start') return null
  return null
}

function ChatPanel({
  conversationId,
  runId,
  windowId = null,
  label = 'this run',
  autoRequest = null,
  onAutoRequestSent,
}: ChatPanelProps) {
  const agent = useEveAgent()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const sentAutoRequestRef = useRef<string | null>(null)
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<Scope>(windowId != null ? 'window' : 'whole')
  const [expanded, setExpanded] = useState(false)

  const busy = agent.status === 'submitted' || agent.status === 'streaming'
  const hasStreamingMessage = useMemo(
    () =>
      agent.data.messages.some((message) =>
        message.parts.some((part) => 'state' in part && part.state === 'streaming'),
      ),
    [agent.data.messages],
  )
  const activity = useMemo(() => recentActivity(agent.events), [agent.events])

  useEffect(() => {
    const body = bodyRef.current
    if (body && body.scrollHeight - body.scrollTop - body.clientHeight > 160) return
    if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ block: 'end' })
      scrollFrameRef.current = null
    })
    return () => {
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    }
  }, [agent.data.messages, agent.status, activity.length])

  useEscapeKey(() => setExpanded(false), expanded)

  useEffect(() => {
    if (!autoRequest || busy || sentAutoRequestRef.current === autoRequest.id) return
    sentAutoRequestRef.current = autoRequest.id
    if (agent.status === 'error') agent.reset()
    void agent
      .send({
        message: autoRequest.message,
        clientContext: autoRequest.clientContext,
      })
      .finally(() => onAutoRequestSent?.(autoRequest.id))
  }, [agent, autoRequest, busy, onAutoRequestSent])

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

  const respondToInput = useCallback<RespondFn>(
    (response) => {
      if (agent.status === 'error') return
      void agent.send({
        inputResponses: [response],
        clientContext: {
          scope,
          conversationId: conversationId ?? null,
          runId: runId ?? null,
          windowId: scope === 'window' ? windowId : null,
        },
      })
    },
    [agent, scope, conversationId, runId, windowId],
  )

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

      <div className="chat-body" ref={bodyRef}>
        {agent.data.messages.map((message, mi) =>
          message.role === 'user' ? (
            <div key={mi} className="turn user">
              <div className="bubble">{message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</div>
            </div>
          ) : (
            <div key={mi} className="turn agent">
              {message.parts.map((part, pi) => renderPart(part, pi, respondToInput))}
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

export default memo(ChatPanel)
