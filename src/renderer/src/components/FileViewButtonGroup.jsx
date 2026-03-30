/**
 * Action bar for the file-list page: folder creation, file upload,
 * and the smart-classify toggle (all visible before selecting files).
 */
import { ButtonGroup, Button, Switch, Typography } from '@material-tailwind/react'
import AddFolderDialog from './AddFolderDialog'
import { ArrowUpTrayIcon, FolderPlusIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import AnalysisSpinner from './AnalysisSpinner'
import {
  readUploadSmartClassifyBeforeUpload,
  writeUploadSmartClassifyBeforeUpload
} from '../lib/smartClassifyPrefs'

function FileViewButtonGroup({ curPath }) {
  const [folderOpen, setFolderOpen] = useState(false)
  const [smartOn, setSmartOn] = useState(() => readUploadSmartClassifyBeforeUpload())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)

  // Sync toggle with main process on mount and when prefs change elsewhere
  useEffect(() => {
    const v = readUploadSmartClassifyBeforeUpload()
    setSmartOn(v)
    void window.electronAPI?.setUploadBatchSmartClassify?.(v)

    const sync = () => {
      const updated = readUploadSmartClassifyBeforeUpload()
      setSmartOn(updated)
    }
    window.addEventListener('scs-smart-classify-prefs-changed', sync)
    return () => window.removeEventListener('scs-smart-classify-prefs-changed', sync)
  }, [])

  // Listen for classification progress from main process
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

  function handleToggle(checked) {
    setSmartOn(checked)
    writeUploadSmartClassifyBeforeUpload(checked)
    void window.electronAPI?.setUploadBatchSmartClassify?.(checked)
  }

  function uploadHandler() {
    window.electronAPI.askUploadFile(curPath.at(-1).folderId)
  }

  return (
    <div className="flex flex-row items-stretch h-11 gap-2 shrink-0">
      {/* Upload / folder buttons */}
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

      {/* Smart-classify toggle — inline with buttons */}
      <div className="flex flex-row items-center gap-2 h-full rounded-md border border-blue-gray-200 bg-white px-2.5">
        <Switch
          id="sc-toggle"
          checked={smartOn}
          onChange={(e) => handleToggle(e.target.checked)}
          color="blue"
        />
        <label
          htmlFor="sc-toggle"
          className="flex flex-row items-center gap-1.5 cursor-pointer select-none"
        >
          <Typography variant="small" className="font-medium text-blue-gray-800 text-xs">
            智慧分類
          </Typography>
          {busy && (
            <>
              <AnalysisSpinner className="h-3 w-3" />
              <Typography variant="small" className="text-xs text-blue-600">
                {progress ? `${progress.done}/${progress.total} 段` : '分析中…'}
              </Typography>
            </>
          )}
        </label>
      </div>

      <AddFolderDialog open={folderOpen} setOpen={setFolderOpen} />
    </div>
  )
}

FileViewButtonGroup.propTypes = {
  curPath: PropTypes.array.isRequired
}

export default FileViewButtonGroup
