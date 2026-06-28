import { describe, expect, it } from 'vitest'
import { buildHarborTask } from './harbor-export'
import type { LabelingWindowDetail, WindowLabel, WindowMessage } from '../api/types'

function message(id: number, ordinal: number, text: string, isFromMe = false): WindowMessage {
  return {
    id,
    conversationId: 1,
    conversationOrdinal: ordinal,
    sourceRowid: ordinal,
    guid: `guid-${id}`,
    senderContactId: null,
    senderName: isFromMe ? null : 'Alex',
    text,
    sentAt: ordinal * 1000,
    isFromMe,
    isRead: true,
    hasAttachments: false,
    status: 'delivered',
    slice: 'all',
  }
}

const label: WindowLabel = {
  id: 1,
  windowId: 42,
  labeler: 'human',
  dominant: 'sadness',
  acceptableDominants: ['sadness', 'neutral'],
  scores: { sadness: 0.8, neutral: 0.2 },
  requiresContext: true,
  sarcasmOrSubtext: false,
  ambiguity: 'low',
  stateLabel: null,
  evidenceMessageRefs: [101],
  pivotalMessageRefs: [],
  notes: 'reads distant and withdrawn',
  createdAt: 1,
  updatedAt: 2,
}

function detailWith(overrides: Partial<LabelingWindowDetail> = {}): LabelingWindowDetail {
  return {
    window: { id: 42 },
    conversation: { title: 'Test Chat' },
    contextMessages: [message(100, 1, 'hey how are you', true)],
    focalMessages: [message(101, 2, 'i guess im fine, whatever')],
    label,
    ...overrides,
  } as unknown as LabelingWindowDetail
}

describe('buildHarborTask', () => {
  it('produces the full Harbor task layout', () => {
    const task = buildHarborTask(detailWith())
    expect(task.taskId).toBe('window-42')
    const paths = task.files.map((f) => f.path).sort()
    expect(paths).toEqual([
      'environment/Dockerfile',
      'instruction.md',
      'solution/solve.sh',
      'task.toml',
      'tests/gold.json',
      'tests/llm_judge.py',
      'tests/test.sh',
    ])
  })

  it('marks scripts executable', () => {
    const task = buildHarborTask(detailWith())
    const exec = task.files.filter((f) => f.executable).map((f) => f.path).sort()
    expect(exec).toEqual(['solution/solve.sh', 'tests/test.sh'])
  })

  it('puts the focal messages in the instruction but never leaks the gold label', () => {
    const file = (p: string) => buildHarborTask(detailWith()).files.find((f) => f.path === p)!.content
    const instruction = file('instruction.md')
    expect(instruction).toContain('i guess im fine, whatever') // focal message
    expect(instruction).toContain('hey how are you') // context message
    // The 7 anchors are listed as the label space, but no gold-specific signal leaks:
    expect(instruction).not.toContain('reads distant') // gold notes
    expect(instruction).not.toContain('acceptable') // gold acceptable-set framing
    expect(instruction).not.toContain('gold') // no reference to the answer
  })

  it('embeds the gold label and focal text only in the verifier-only gold.json', () => {
    const gold = JSON.parse(
      buildHarborTask(detailWith()).files.find((f) => f.path === 'tests/gold.json')!.content,
    )
    expect(gold.dominant).toBe('sadness')
    expect(gold.acceptableDominants).toEqual(['sadness', 'neutral'])
    expect(gold.scores.sadness).toBe(0.8)
    expect(gold.notes).toBe('reads distant and withdrawn')
    expect(gold.focalText).toContain('i guess im fine')
  })

  it('oracle solution writes the gold dominant as result.json', () => {
    const solve = buildHarborTask(detailWith()).files.find((f) => f.path === 'solution/solve.sh')!.content
    expect(solve).toContain('/app/result.json')
    expect(solve).toContain('"dominant": "sadness"')
    expect(solve).toContain('"sadness": 0.8')
  })

  it('throws when the window has no human label', () => {
    expect(() => buildHarborTask(detailWith({ label: null }))).toThrow(/no human label/)
  })
})
