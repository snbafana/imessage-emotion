import type { AppDatabase } from '../db/schema.ts'
import {
  retrieveConversationContext,
  type AskConversationInput,
  type ChatWindow,
  type ChatWindowMessage,
  type ConversationChatPacket,
} from './retrieve.ts'

export interface ChatCitation {
  type: 'window' | 'message' | 'run'
  id: number
  label: string
}

export interface ConversationChatResponse {
  answer: string
  citations: ChatCitation[]
}

export function answerConversation(
  db: AppDatabase,
  input: AskConversationInput,
): ConversationChatResponse {
  return answerConversationFromPacket(retrieveConversationContext(db, input))
}

function answerConversationFromPacket(
  packet: ConversationChatPacket,
): ConversationChatResponse {
  const selected = packet.selectedWindow
  const citations = citationsFor(packet)
  const resultLine = metadataLine('Result', selected.result)
  const shiftLine = metadataLine('Shift', selected.shift)
  const neighbors = packet.neighboringWindows.map(windowLabel).join(', ') || 'none available'

  const answer = [
    `Scoped answer for conversation #${packet.conversation.id} (${packet.conversation.title}), run #${packet.run.id}, window #${selected.id}.`,
    `Selected window: ${windowLabel(selected)} covering ordinals ${selected.startOrdinal}-${selected.endOrdinal}.`,
    `Context/old messages: ${messageRange(packet.contextMessages)} (${packet.contextMessages.length} messages).`,
    `Focal/new messages: ${messageRange(packet.focalMessages)} (${packet.focalMessages.length} messages).`,
    resultLine,
    shiftLine,
    `Neighboring windows: ${neighbors}.`,
    `Question answered from the selected run/window packet: ${packet.question}`,
  ].join('\n')

  return { answer, citations }
}

function citationsFor(packet: ConversationChatPacket): ChatCitation[] {
  const selected = packet.selectedWindow
  const messages = [
    ...edgeMessages(packet.contextMessages),
    ...edgeMessages(packet.focalMessages),
  ]
  const byKey = new Map<string, ChatCitation>()

  addCitation(byKey, {
    type: 'run',
    id: packet.run.id,
    label: `run #${packet.run.id}`,
  })
  addCitation(byKey, {
    type: 'window',
    id: selected.id,
    label: windowLabel(selected),
  })
  for (const message of messages) {
    addCitation(byKey, {
      type: 'message',
      id: message.id,
      label: `${message.role} message #${message.id} (ordinal ${message.ordinal})`,
    })
  }

  return [...byKey.values()]
}

function addCitation(citations: Map<string, ChatCitation>, citation: ChatCitation): void {
  citations.set(`${citation.type}:${citation.id}`, citation)
}

function edgeMessages(messages: ChatWindowMessage[]): ChatWindowMessage[] {
  if (messages.length <= 2) return messages
  return [messages[0], messages[messages.length - 1]]
}

function messageRange(messages: ChatWindowMessage[]): string {
  if (messages.length === 0) return 'none'
  const first = messages[0]
  const last = messages[messages.length - 1]
  return `ordinals ${first.ordinal}-${last.ordinal}, message ids ${first.id}-${last.id}`
}

function windowLabel(window: ChatWindow): string {
  const ordinal = window.ordinal === null ? '' : `window ${window.ordinal} · `
  return `${ordinal}id ${window.id}`
}

function metadataLine(label: string, metadata: Record<string, unknown>): string {
  const summary = stringField(metadata, 'summary') ?? stringField(metadata, 'label')
  const dominant = stringField(metadata, 'dominant')
  const method = stringField(metadata, 'method')
  const parts = [
    summary,
    dominant ? `dominant ${dominant}` : null,
    method ? `method ${method}` : null,
  ].filter((part): part is string => part !== null)

  return `${label} metadata: ${parts.length > 0 ? parts.join('; ') : 'none recorded'}.`
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : null
}
