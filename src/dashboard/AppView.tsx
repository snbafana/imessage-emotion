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

  useEffect(() => {
    if (status && !status.ready && setupComplete) {
      window.localStorage.removeItem(SETUP_COMPLETE_KEY)
      setSetupComplete(false)
    }
  }, [setupComplete, status])

  const continueToDashboard = useCallback(() => {
    window.localStorage.setItem(SETUP_COMPLETE_KEY, 'true')
    setSetupComplete(true)
    setShowSettings(false)
  }, [])

  if (showSettings || !setupComplete || !status?.ready) {
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
