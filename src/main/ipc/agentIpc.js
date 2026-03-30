/**
 * IPC handlers for the metadata search agent.
 *
 * Channels:
 *   agent:query  — run a single agent turn
 *                  payload: { userMessage, history, rawFiles }
 *                  returns: AgentTurnResult
 */
import { ipcMain } from 'electron'
import { buildSearchableMetadata } from '../services/MetadataCollector.js'
import { runAgentTurn } from '../services/AgentService.js'
import { logger } from '../Logger.js'

let _databaseManager = null
let _registered = false

/** Inject the DatabaseManager so we can read local tags. Call from index.js. */
export function setDatabaseManagerForAgentIpc(databaseManager) {
  _databaseManager = databaseManager
}

export function registerAgentIpcOnce() {
  if (_registered) return
  _registered = true

  ipcMain.handle('agent:query', async (_event, { userMessage, history = [], rawFiles = [], uploaderName = '' }) => {
    try {
      logger.info(`[AgentIpc] agent:query — "${userMessage.slice(0, 80)}"`)

      // Only public files (perm === 1) are searchable — private files are never exposed
      const publicOnly = rawFiles.filter((f) => (f.perm ?? f.permissions ?? 0) === 1)
      logger.debug(`[AgentIpc] total=${rawFiles.length}, public=${publicOnly.length}`)

      const files = buildSearchableMetadata(publicOnly, _databaseManager, uploaderName)
      const result = await runAgentTurn({ userMessage, history, files })
      return { ok: true, ...result }
    } catch (e) {
      logger.error(`[AgentIpc] agent:query error: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })
}
