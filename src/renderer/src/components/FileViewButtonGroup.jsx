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

function FileViewButtonGroup({ curPath }) {
  const [folderOpen, setFolderOpen] = useState(false)
  const [mode, setMode] = useState(() => readSmartClassifyMode())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)

  useEffect(() => {
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

      {/* Smart-classify mode selector */}
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

      <AddFolderDialog open={folderOpen} setOpen={setFolderOpen} />
    </div>
  )
}

FileViewButtonGroup.propTypes = {
  curPath: PropTypes.array.isRequired
}

export default FileViewButtonGroup
