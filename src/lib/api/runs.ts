import type { AppDatabase } from '../db/schema'
import type { RunSummaryMetadata } from './types'
import { computeAndStoreRunSummary } from '../emotion/run-summary'
import type { ShiftDetectionOptions } from '../emotion/shifts'

export function refreshRunSummary(
  db: AppDatabase,
  runId: number,
  options: ShiftDetectionOptions = {},
): RunSummaryMetadata {
  return computeAndStoreRunSummary(db, runId, options)
}
