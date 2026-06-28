'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Dashboard from './Dashboard'
import Onboarding from './Onboarding'
import { getDashboardApi } from './api'
import type { OnboardingStatus } from '../lib/api/types'

const SETUP_COMPLETE_KEY = 'imessage-emotion.setup-complete'

export default function AppView() {
  const api = useMemo(() => getDashboardApi(), [])
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [setupComplete, setSetupComplete] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const refresh = useCallback(async () => {
    if (!api?.getOnboardingStatus) return
    setStatus(await api.getOnboardingStatus())
  }, [api])

  useEffect(() => {
    setSetupComplete(window.localStorage.getItem(SETUP_COMPLETE_KEY) === 'true')
    void refresh()
  }, [refresh])

  const continueToDashboard = useCallback(() => {
    window.localStorage.setItem(SETUP_COMPLETE_KEY, 'true')
    setSetupComplete(true)
    setShowSettings(false)
  }, [])

  // Continue always proceeds to the dashboard, regardless of local sync/permission
  // readiness — anyone can click through and run on seeded mock data
  // (see `pnpm seed:mock`). Onboarding only shows before first Continue, or when
  // the user explicitly reopens it via Settings.
  if (showSettings || !setupComplete) {
    return (
      <Onboarding
        api={api}
        initialStatus={status}
        continueLabel={showSettings ? 'Back to dashboard' : 'Continue'}
        showBackButton={showSettings}
        onContinue={continueToDashboard}
        onStatusChange={setStatus}
      />
    )
  }

  return <Dashboard onOpenSettings={() => setShowSettings(true)} />
}
