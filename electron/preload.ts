import { contextBridge, ipcRenderer } from 'electron'
import {
  API_CHANNELS,
  type AskConversationInput,
  type BaselineRunOptions,
  type ImessageEmotionApi,
  type WindowMessageSlice,
} from '../src/lib/api/types'

const appApi: ImessageEmotionApi = {
  syncMessagesNow: () => ipcRenderer.invoke(API_CHANNELS.syncMessagesNow),
  listConversations: () => ipcRenderer.invoke(API_CHANNELS.listConversations),
  getConversation: (conversationId: number) =>
    ipcRenderer.invoke(API_CHANNELS.getConversation, conversationId),
  analyzeConversation: (conversationId: number, options?: BaselineRunOptions) =>
    ipcRenderer.invoke(API_CHANNELS.analyzeConversation, conversationId, options),
  listRuns: (conversationId: number) => ipcRenderer.invoke(API_CHANNELS.listRuns, conversationId),
  getRunWindows: (runId: number) => ipcRenderer.invoke(API_CHANNELS.getRunWindows, runId),
  getWindowMessages: (windowId: number, slice?: WindowMessageSlice) =>
    ipcRenderer.invoke(API_CHANNELS.getWindowMessages, windowId, slice),
  askConversation: (input: AskConversationInput) =>
    ipcRenderer.invoke(API_CHANNELS.askConversation, input),
}

contextBridge.exposeInMainWorld('ipcRenderer', appApi)
