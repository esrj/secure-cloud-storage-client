/**
 * Action bar for the file-list page: folder creation, file upload,
 * and the smart-classify mode selector (all visible before selecting files).
 */
import { ButtonGroup, Button, Typography } from '@material-tailwind/react'
import AddFolderDialog from './AddFolderDialog'
import { ArrowUpTrayIcon, FolderPlusIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import AnalysisSpinner from './AnalysisSpinner'
import { readSmartClassifyMode, writeSmartClassifyMode } from '../lib/smartClassifyPrefs'

const MODE_LABELS = {
  off: '智慧標籤 - 關閉',
  fast: '智慧標籤 - fast',
  medium: '智慧標籤 - thinking'
}

// ── DEMO_HIDE_SMART_FEATURES ─────────────────────────────────────────
// Demo 期間隱藏智慧標籤下拉。要恢復時把這個常數改成 false 即可，所有
// 邏輯都會自動回到原狀（dropdown 顯示、mode 從 localStorage 讀、會觸發
// 上傳前分類）。
//
// 為何用 flag 而不是直接砍程式碼：
//   • 保留 `mode` / `handleModeChange` / classifier 訊息訂閱等行為，避免之
//     後恢復時又要重做一輪。
//   • 強制把 mode 設成 'off' 並推到主程序，避免使用者上次選了 'fast' /
//     'medium' 的 localStorage 殘值在 demo 時誤啟動 LLM。
// 同個 marker 也在 NavBar.jsx、MainView.jsx 出現，一起恢復。
const SMART_CLASSIFY_DEMO_HIDDEN = true

function FileViewButtonGroup({ curPath }) {
  const [folderOpen, setFolderOpen] = useState(false)
  const [mode, setMode] = useState(() =>
    SMART_CLASSIFY_DEMO_HIDDEN ? 'off' : readSmartClassifyMode()
  )
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)

  useEffect(() => {
    if (SMART_CLASSIFY_DEMO_HIDDEN) {
      // 強制關閉並把這個決定推到主程序，避免上傳時誤啟動分類器。
      setMode('off')
      void window.electronAPI?.setUploadBatchSmartClassify?.('off')
      return
    }
    const v = readSmartClassifyMode()
    setMode(v)
    void window.electronAPI?.setUploadBatchSmartClassify?.(v)

    const sync = () => {
      const updated = readSmartClassifyMode()
      setMode(updated)
    }
    window.addEventListener('scs-smart-classify-prefs-changed', sync)
    return () => window.removeEventListener('scs-smart-classify-prefs-changed', sync)
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI?.onPreuploadClassifyStatus?.((p) => {
      if (p?.phase === 'running') {
        setBusy(true)
        if (typeof p.progress?.done === 'number' && typeof p.progress?.total === 'number') {
          setProgress(p.progress)
        }
      }
      if (p?.phase === 'finished') {
        setBusy(false)
        setProgress(null)
      }
    })
    return () => unsub?.()
  }, [])

  function handleModeChange(e) {
    const next = e.target.value
    setMode(next)
    writeSmartClassifyMode(next)
    void window.electronAPI?.setUploadBatchSmartClassify?.(next)
  }

  function uploadHandler() {
    window.electronAPI.askUploadFile(curPath.at(-1).folderId)
  }

  return (
    <div className="flex flex-row items-stretch h-11 gap-2 shrink-0">
      <ButtonGroup variant="outlined" className="h-full">
        <Button
          onClick={() => setFolderOpen(!folderOpen)}
          className="flex flex-row h-full px-3 gap-1.5 items-center justify-center"
        >
          <FolderPlusIcon className="size-4" />
          <Typography variant="small">資料夾</Typography>
        </Button>
        <Button
          onClick={() => uploadHandler()}
          className="flex flex-row h-full px-3 gap-1.5 items-center justify-center"
        >
          <ArrowUpTrayIcon className="size-4" />
          <Typography variant="small">上傳</Typography>
        </Button>
      </ButtonGroup>

      {/* DEMO_HIDE_SMART_FEATURES: 智慧標籤下拉與分析中狀態暫時隱藏。
          要恢復時把 SMART_CLASSIFY_DEMO_HIDDEN 改為 false 即可，
          此區塊會自動顯示。 */}
      {!SMART_CLASSIFY_DEMO_HIDDEN && (
        <>
          <select
            value={mode}
            onChange={handleModeChange}
            className="text-xs h-full rounded-md border border-blue-gray-200 bg-white px-2
                       text-blue-gray-800 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            {Object.entries(MODE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          {busy && (
            <div className="flex flex-row items-center gap-1.5 h-full px-1">
              <AnalysisSpinner className="h-3 w-3" />
              <Typography variant="small" className="text-xs text-blue-600">
                {progress ? `${progress.done}/${progress.total} 段` : '分析中…'}
              </Typography>
            </div>
          )}
        </>
      )}

      <AddFolderDialog open={folderOpen} setOpen={setFolderOpen} />
    </div>
  )
}

FileViewButtonGroup.propTypes = {
  curPath: PropTypes.array.isRequired
}

export default FileViewButtonGroup
