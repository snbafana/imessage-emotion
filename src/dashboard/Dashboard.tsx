'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEveAgent } from 'eve/react'
import { Avatar } from '@base-ui/react/avatar'
import { Button } from '@base-ui/react/button'
import EmotionTimeline, { AnalysisSetupPanel } from './EmotionTimeline'
import type { AnalysisSetupPlan, AnalysisSetupValue } from './EmotionTimeline'
import ChatPanel from './ChatPanel'
import Inspector from './Inspector'
import Sidebar from './Sidebar'
import ControlRoom from './rooms/ControlRoom'
import TwoTierRoom from './rooms/TwoTierRoom'
import { useEscapeKey } from './shared/useEscapeKey'
import { getDashboardApi } from './api'
import {
  formatDateRange,
  formatMessageCount,
  getWindowMessages,
  hasConversationApi,
  latestRun,
  normalizeConversations,
  normalizeRuns,
  normalizeWindows,
  type ConversationView,
  type MessageView,
  type RunView,
  type WindowView,
} from './data'
import { RecalcIcon } from './icons'
import type { AnalysisRunOptions, SyncStatus } from '../lib/api/types'
import { planCappedRunWindowConfig, planRunWindowRanges } from '../lib/windows/windows'
import './dashboard.css'

const DEFAULT_ANALYSIS_SETUP: AnalysisSetupValue = {
  method: 'ax',
  planner: 'capped',
  provider: 'openrouter',
  effort: 'medium',
  model: 'google/gemini-2.5-flash',
  maxWindows: 200,
  overlapPercent: 25,
  contextMessages: 80,
  focalMessages: 40,
  minFocalMessages: 20,
  twoTierFocal: 4,
  twoTierStride: 1,
  topK: 25,
}

export default function Dashboard({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const api = useMemo(() => getDashboardApi(), [])
  const [conversations, setConversations] = useState<ConversationView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunView[]>([])
  const [run, setRun] = useState<RunView | null>(null)
  const [windows, setWindows] = useState<WindowView[]>([])
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null)
  const [contextMessages, setContextMessages] = useState<MessageView[]>([])
  const [focalMessages, setFocalMessages] = useState<MessageView[]>([])
  const [conversationLoading, setConversationLoading] = useState(true)
  const [runLoading, setRunLoading] = useState(false)
  const [windowLoading, setWindowLoading] = useState(false)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [windowError, setWindowError] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [analysisSetup, setAnalysisSetup] =
    useState<AnalysisSetupValue>(DEFAULT_ANALYSIS_SETUP)
  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [showTwoTier, setShowTwoTier] = useState(false)
  // Recompute opens a settings popup first instead of running immediately.
  const [showRecalcSetup, setShowRecalcSetup] = useState(false)
  const [showControlRoom, setShowControlRoom] = useState(false)
  // null = no active search (show everything); a Set = the conversation ids
  // whose participants matched the contacts FTS query.
  const [matchedConversationIds, setMatchedConversationIds] = useState<Set<string> | null>(null)

  const visibleConversations = useMemo(
    () => {
      const query = searchQuery.trim().toLowerCase()
      if (!query) return conversations
      return conversations.filter(
        (conversation) =>
          conversationMatchesQuery(conversation, query) ||
          matchedConversationIds?.has(String(conversation.rawId)),
      )
    },
    [conversations, matchedConversationIds, searchQuery],
  )

  // The eve agent backs the "Ask the timeline" chat only; analysis runs go
  // through the direct tRPC path with live polling (see startAxRun below).
  const chat = useEveAgent()
  // Run id currently being scored in the background; drives the live poll.
  const [liveRunId, setLiveRunId] = useState<number | null>(null)
  // Once a run finishes we ask eve to surface insights automatically. These refs
  // let the live-poll effect trigger that without re-subscribing on every chat
  // streaming tick, and guard against firing twice for the same run.
  const requestInsightsRef = useRef<(run: RunView) => void>(() => {})
  const insightRequestedRunRef = useRef<number | null>(null)

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  )
  const selectedWindow = useMemo(
    () => windows.find((window) => window.id === selectedWindowId) ?? null,
    [selectedWindowId, windows],
  )
  const isSyncing =
    syncStatus?.messages.state === 'syncing' || syncStatus?.contacts.state === 'syncing'
  const syncStatusLine = syncError ?? actionStatus ?? formatSyncStatus(syncStatus)
  const setupPlan = useMemo(
    () =>
      selectedConversation
        ? buildAnalysisSetupPlan(analysisSetup, selectedConversation.messageCount)
        : null,
    [analysisSetup, selectedConversation],
  )

  // Kept current on every render so the live-poll effect can fire it with the
  // latest chat helpers without listing `chat` (which changes each stream tick)
  // as a dependency.
  requestInsightsRef.current = (finishedRun: RunView) => {
    if (chat.status === 'submitted' || chat.status === 'streaming') return
    if (chat.status === 'error') chat.reset()
    const scored = finishedRun.scoredWindowCount ?? finishedRun.windowCount ?? 0
    void chat.send({
      message:
        `The "${selectedConversation?.title ?? 'conversation'}" analysis just finished ` +
        `(${finishedRun.scaleLabel}, ${scored} scored windows). Summarize the key emotional ` +
        `insights across the whole timeline: the dominant moods, the biggest emotional shifts ` +
        `and which windows they happen in, and anything worth a closer look. Keep it concise.`,
      clientContext: {
        scope: 'whole',
        conversationId: selectedConversation ? Number(selectedConversation.rawId) : null,
        runId: Number(finishedRun.rawId),
        windowId: null,
      },
    })
  }

  const reloadConversations = useCallback(async () => {
    if (!hasConversationApi(api)) {
      setConversationLoading(false)
      setConversationError('Dashboard API is not available.')
      return
    }

    setConversationLoading(true)
    setConversationError(null)
    try {
      const next = normalizeConversations(await api.listConversations())
      setConversations(next)
      setActiveId((current) =>
        current && next.some((conversation) => conversation.id === current)
          ? current
          : next[0]?.id ?? null,
      )
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : 'Could not load conversations.')
    } finally {
      setConversationLoading(false)
    }
  }, [api])

  const reloadRun = useCallback(
    async (conversation: ConversationView | null) => {
      setRun(null)
      setRuns([])
      setWindows([])
      setSelectedWindowId(null)
      setContextMessages([])
      setFocalMessages([])
      setRunError(null)

      if (!conversation) return

      setRunLoading(true)
      try {
        let nextRuns: RunView[] = []
        if (api?.getConversation) {
          nextRuns = normalizeRuns(await api.getConversation(Number(conversation.rawId)))
        }
        if (api?.listRuns) {
          nextRuns = normalizeRuns(await api.listRuns(Number(conversation.rawId)))
        }
        if (nextRuns.length === 0 && conversation.latestRun) {
          nextRuns = [conversation.latestRun]
        }
        const orderedRuns = [...nextRuns].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        setRuns(orderedRuns)
        setRun(latestRun(orderedRuns))
      } catch (error) {
        setRunError(error instanceof Error ? error.message : 'Could not load analysis runs.')
      } finally {
        setRunLoading(false)
      }
    },
    [api],
  )

  const reloadWindows = useCallback(
    async (activeRun: RunView | null) => {
      setWindows([])
      setSelectedWindowId(null)
      setContextMessages([])
      setFocalMessages([])
      setRunError(null)

      if (!activeRun) return
      if (!api?.getRunWindows) {
        setRunError('Run window API is not available.')
        return
      }

      setRunLoading(true)
      try {
        const nextWindows = normalizeWindows(await api.getRunWindows(Number(activeRun.rawId)))
        setWindows(nextWindows)
        setSelectedWindowId(nextWindows.find((window) => window.state === 'scored')?.id ?? nextWindows[0]?.id ?? null)
      } catch (error) {
        setRunError(error instanceof Error ? error.message : 'Could not load run windows.')
      } finally {
        setRunLoading(false)
      }
    },
    [api],
  )

  useEffect(() => {
    void reloadConversations()
  }, [reloadConversations])

  useEscapeKey(() => setShowRecalcSetup(false), showRecalcSetup)

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || !api?.searchContacts) {
      setMatchedConversationIds(null)
      return
    }

    let cancelled = false
    const handle = window.setTimeout(async () => {
      try {
        const hits = await api.searchContacts(query)
        if (cancelled) return
        const ids = new Set<string>()
        for (const hit of hits) {
          for (const conversationId of hit.conversationIds) ids.add(String(conversationId))
        }
        setMatchedConversationIds(ids)
      } catch {
        if (!cancelled) setMatchedConversationIds(new Set())
      }
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [api, searchQuery])

  useEffect(() => {
    void reloadRun(selectedConversation)
  }, [reloadRun, selectedConversation])

  useEffect(() => {
    // While a run is scoring in the background the poll owns window updates;
    // skip the reset-and-refetch here so the timeline doesn't flicker each tick.
    if (run && liveRunId != null && Number(run.rawId) === liveRunId) return
    void reloadWindows(run)
  }, [reloadWindows, run, liveRunId])

  useEffect(() => {
    let cancelled = false

    async function loadSyncStatus() {
      if (!api?.getSyncStatus) return
      try {
        const nextStatus = await api.getSyncStatus()
        if (!cancelled) {
          setSyncStatus(nextStatus)
          setSyncError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setSyncError(error instanceof Error ? error.message : 'Could not load sync status.')
        }
      }
    }

    void loadSyncStatus()
    const interval = window.setInterval(() => void loadSyncStatus(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [api])

  useEffect(() => {
    let cancelled = false

    async function loadMessages() {
      setContextMessages([])
      setFocalMessages([])
      setWindowError(null)

      if (!selectedWindow || !api?.getWindowMessages) return

      setWindowLoading(true)
      try {
        const [context, focal] = await Promise.all([
          getWindowMessages(api, selectedWindow.rawId, 'context'),
          getWindowMessages(api, selectedWindow.rawId, 'focal'),
        ])
        if (!cancelled) {
          setContextMessages(context)
          setFocalMessages(focal)
        }
      } catch (error) {
        if (!cancelled) {
          setWindowError(error instanceof Error ? error.message : 'Could not load window messages.')
        }
      } finally {
        if (!cancelled) setWindowLoading(false)
      }
    }

    void loadMessages()
    return () => {
      cancelled = true
    }
  }, [api, selectedWindow])

  async function syncMessages() {
    if (!api?.syncMessagesNow) return
    setActionStatus('Syncing messages and contacts...')
    setSyncError(null)
    try {
      const messageStatus = await api.syncMessagesNow()
      setSyncStatus(messageStatus)
      const finalStatus = api.syncContactsNow ? await api.syncContactsNow() : messageStatus
      setSyncStatus(finalStatus)
      await reloadConversations()
      setActionStatus(formatSyncStatus(finalStatus))
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Sync failed.')
      setActionStatus(null)
    }
  }

  // Kick off a background analysis run and let the live poll fill the timeline
  // window-by-window. Returns immediately after the run + windows are created.
  const startAxRun = useCallback(async () => {
    if (!selectedConversation || !api?.createAnalysisRun || !setupPlan || setupPlan.error) return

    setAnalysisRunning(true)
    setRunError(null)
    setShowControlRoom(true)
    setActionStatus(`Scoring windows with ${analysisSetup.model}...`)
    try {
      const options = analysisRunOptions(analysisSetup, setupPlan)
      const created = await api.createAnalysisRun(Number(selectedConversation.rawId), options)
      const createdRun = normalizeRuns([created])[0]
      // Show the freshly created (still-scoring) run and its unscored windows now,
      // then hand window updates to the poll effect below.
      await reloadRun(selectedConversation)
      if (createdRun) setLiveRunId(Number(createdRun.rawId))
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Analysis run failed.')
      setActionStatus(null)
      setAnalysisRunning(false)
    }
  }, [analysisSetup, api, reloadRun, selectedConversation, setupPlan])

  const startSelectedAnalysis = useCallback(() => {
    if (!selectedConversation || !setupPlan || setupPlan.error) return
    if (analysisSetup.method === 'two-tier') {
      setActionStatus('Streaming RoBERTa -> RLM analysis...')
      setShowTwoTier(true)
      return
    }
    void startAxRun()
  }, [analysisSetup.method, selectedConversation, setupPlan, startAxRun])

  function selectRun(runId: string) {
    const nextRun = runs.find((item) => item.id === runId)
    if (nextRun) setRun(nextRun)
  }

  // Live progress: while a run scores in the background, poll its windows so the
  // timeline grows window-by-window, and stop once the run leaves the running
  // state. Owns `windows` for the live run (reloadWindows is gated off above).
  useEffect(() => {
    if (liveRunId == null || !selectedConversation || !api?.listRuns || !api?.getRunWindows) return
    const listRunsFn = api.listRuns
    const getRunWindowsFn = api.getRunWindows
    const conversationRawId = Number(selectedConversation.rawId)
    let cancelled = false

    async function tick() {
      try {
        const [runsRaw, windowsRaw] = await Promise.all([
          listRunsFn(conversationRawId),
          getRunWindowsFn(liveRunId as number),
        ])
        if (cancelled) return
        const nextRuns = normalizeRuns(runsRaw).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        setRuns(nextRuns)
        setWindows(normalizeWindows(windowsRaw))
        const live = nextRuns.find((item) => Number(item.rawId) === liveRunId)
        if (live) setRun(live)
        if (!live || live.state !== 'pending') {
          setLiveRunId(null)
          setAnalysisRunning(false)
          setActionStatus(
            live?.state === 'failed'
              ? `Analysis failed${live.error ? `: ${live.error}` : '.'}`
              : `Analysis finished with ${analysisSetup.model}.`,
          )
          // On a successful run, have eve surface insights in the chat — once.
          if (live && live.state !== 'failed' && insightRequestedRunRef.current !== liveRunId) {
            insightRequestedRunRef.current = liveRunId
            requestInsightsRef.current(live)
          }
        }
      } catch {
        // Transient read error — keep polling; a persistent failure surfaces via
        // the run row's own error state.
      }
    }

    void tick()
    const interval = window.setInterval(() => void tick(), 800)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [analysisSetup.model, api, liveRunId, selectedConversation])

  return (
    <div className="dashboard">
      <Sidebar
        activeId={activeId}
        conversations={visibleConversations}
        loading={conversationLoading}
        error={conversationError}
        onSelect={setActiveId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenSettings={onOpenSettings}
      />

      <div className="main">
        <header className="header-bar">
          <Avatar.Root
            className="avatar"
            style={{ background: selectedConversation?.avatar ?? '#1f44ff' }}
          >
            <Avatar.Fallback>{selectedConversation?.initial ?? '?'}</Avatar.Fallback>
          </Avatar.Root>
          <div className="id">
            <span className="name">{selectedConversation?.title ?? 'No conversation selected'}</span>
            <span className="range">
              {selectedConversation
                ? [
                    formatDateRange(
                      selectedConversation.firstMessageAt,
                      selectedConversation.lastMessageAt,
                    ),
                    `${formatMessageCount(selectedConversation.messageCount)} messages`,
                    // Only show participants when they add info beyond the title
                    // (group chats) — for 1:1s the title already is the person.
                    selectedConversation.participantSummary &&
                    selectedConversation.participantSummary !== selectedConversation.title
                      ? selectedConversation.participantSummary
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Sync messages to populate the dashboard'}
            </span>
            {syncStatusLine && (
              <span className={`action-status${syncError ? ' error' : ''}`}>{syncStatusLine}</span>
            )}
          </div>
          <div className="header-actions">
            <Button
              className="recalc secondary"
              disabled={!api?.syncMessagesNow || isSyncing}
              onClick={syncMessages}
            >
              <RecalcIcon />
              {isSyncing ? 'Syncing...' : 'Sync Data'}
            </Button>
            <Button
              className="recalc secondary"
              disabled={!selectedConversation || showControlRoom}
              onClick={() => setShowControlRoom(true)}
            >
              Control room
            </Button>
            <Button
              className="recalc"
              disabled={!selectedConversation || analysisRunning || showTwoTier}
              onClick={() => setShowRecalcSetup(true)}
            >
              <RecalcIcon />
              {analysisRunning || showTwoTier ? 'Analyzing...' : 'Recompute'}
            </Button>
          </div>
        </header>

        <div className="body">
          <EmotionTimeline
            run={run}
            runs={runs}
            windows={windows}
            selectedId={selectedWindowId}
            selectedRunId={run?.id ?? null}
            loading={runLoading}
            error={runError}
            conversation={selectedConversation}
            setup={analysisSetup}
            setupPlan={setupPlan}
            setupRunning={analysisRunning || showTwoTier}
            onChangeSetup={(patch) =>
              setAnalysisSetup((current) => ({ ...current, ...patch }))
            }
            onRunSetup={startSelectedAnalysis}
            onSelectRun={selectRun}
            onSelectWindow={setSelectedWindowId}
          />
          <div className="lower-row">
            <Inspector
              run={run}
              window={selectedWindow}
              contextMessages={contextMessages}
              focalMessages={focalMessages}
              loading={windowLoading}
              error={windowError}
            />
            <ChatPanel
              agent={chat}
              conversationId={selectedConversation ? Number(selectedConversation.rawId) : undefined}
              runId={run ? Number(run.rawId) : undefined}
              windowId={selectedWindow ? Number(selectedWindow.rawId) : null}
              label={selectedConversation?.title}
            />
          </div>
        </div>
      </div>

      {showRecalcSetup && (
        <>
          <button
            className="chat-backdrop"
            type="button"
            aria-label="Close analysis setup"
            onClick={() => setShowRecalcSetup(false)}
          />
          <div className="recalc-modal" role="dialog" aria-modal="true" aria-label="Recompute analysis setup">
            <div className="recalc-modal-head">
              <span>Recompute analysis</span>
              <button type="button" className="recalc-modal-close" onClick={() => setShowRecalcSetup(false)}>
                Close
              </button>
            </div>
            <AnalysisSetupPanel
              conversation={selectedConversation}
              setup={analysisSetup}
              plan={setupPlan}
              running={analysisRunning || showTwoTier}
              onChange={(patch) => setAnalysisSetup((current) => ({ ...current, ...patch }))}
              onRun={() => {
                setShowRecalcSetup(false)
                startSelectedAnalysis()
              }}
            />
          </div>
        </>
      )}

      {showTwoTier && selectedConversation && (
        <TwoTierRoom
          conversationId={Number(selectedConversation.rawId)}
          title={selectedConversation.title}
          focal={clampInteger(analysisSetup.twoTierFocal, 1, Math.max(1, selectedConversation.messageCount))}
          stride={clampInteger(analysisSetup.twoTierStride, 1, Math.max(1, selectedConversation.messageCount))}
          topK={clampInteger(analysisSetup.topK, 1, 200)}
          onClose={() => setShowTwoTier(false)}
          onDone={() => {
            setActionStatus('RoBERTa -> RLM analysis finished.')
            void reloadRun(selectedConversation)
          }}
        />
      )}

      {showControlRoom && (
        <ControlRoom
          api={api}
          windows={windows}
          title={selectedConversation?.title}
          busy={analysisRunning}
          onClose={() => setShowControlRoom(false)}
        />
      )}
    </div>
  )
}

function buildAnalysisSetupPlan(
  setup: AnalysisSetupValue,
  messageCount: number,
): AnalysisSetupPlan {
  try {
    if (setup.method === 'two-tier') {
      const focalMessages = clampInteger(setup.twoTierFocal, 1, Math.max(1, messageCount))
      const stride = clampInteger(setup.twoTierStride, 1, Math.max(1, messageCount))
      const config = {
        mode: 'comparative-message-count' as const,
        contextMessages: Math.min(messageCount, focalMessages * 2),
        focalMessages,
        stride,
        minFocalMessages: 1,
      }
      const windowCount = planRunWindowRanges(messageCount, config).length
      return {
        config,
        windowCount,
        error:
          windowCount === 0
            ? 'This conversation is too short for the selected focal window.'
            : null,
      }
    }

    const overlapPercent = clampInteger(setup.overlapPercent, 10, 40)
    const maxWindows = clampInteger(setup.maxWindows, 1, 200)
    const config =
      setup.planner === 'capped'
        ? planCappedRunWindowConfig(messageCount, { maxWindows, overlapPercent }).config
        : {
            mode: 'comparative-message-count' as const,
            contextMessages: clampInteger(setup.contextMessages, 1, Math.max(1, messageCount)),
            focalMessages: clampInteger(setup.focalMessages, 1, Math.max(1, messageCount)),
            stride: Math.max(
              1,
              Math.round(
                clampInteger(setup.focalMessages, 1, Math.max(1, messageCount)) *
                  (1 - overlapPercent / 100),
              ),
            ),
            minFocalMessages: clampInteger(
              setup.minFocalMessages,
              1,
              Math.max(1, clampInteger(setup.focalMessages, 1, Math.max(1, messageCount))),
            ),
          }
    const windowCount = planRunWindowRanges(messageCount, config).length
    const error =
      windowCount > maxWindows
        ? `Estimated ${windowCount} windows exceeds the ${maxWindows} window cap.`
        : windowCount === 0
          ? 'This conversation is too short for the selected context and focal window.'
          : null
    return { config, windowCount, error }
  } catch (error) {
    return {
      config: {
        mode: 'comparative-message-count',
        contextMessages: 0,
        focalMessages: 0,
        stride: 0,
        minFocalMessages: 0,
      },
      windowCount: 0,
      error: error instanceof Error ? error.message : 'Invalid analysis setup.',
    }
  }
}

function analysisRunOptions(
  setup: AnalysisSetupValue,
  plan: AnalysisSetupPlan,
): AnalysisRunOptions {
  return {
    ...plan.config,
    scorerConfig: {
      provider: setup.provider,
      effort: setup.effort,
      model: setup.model.trim(),
      promptKey: 'dashboard-configured-ax-v1',
      label:
        setup.planner === 'capped'
          ? `Ax capped ${setup.overlapPercent}% overlap`
          : `Ax configured ${setup.overlapPercent}% overlap`,
      overlapPercent: setup.overlapPercent,
      maxWindows: setup.maxWindows,
      estimatedWindowCount: plan.windowCount,
      planner: setup.planner,
    },
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function conversationMatchesQuery(conversation: ConversationView, query: string): boolean {
  return [conversation.title, conversation.participantSummary, String(conversation.rawId)]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function formatSyncStatus(status: SyncStatus | null): string | null {
  if (!status) return null
  const messageError = status.messages.error
  const contactsError = status.contacts.error
  if (messageError || contactsError) return messageError ?? contactsError ?? null
  if (status.messages.state === 'syncing') {
    return `Syncing messages at row ${formatMessageCount(status.messages.cursor)}...`
  }
  if (status.contacts.state === 'syncing') return 'Syncing contacts...'
  return null
}
