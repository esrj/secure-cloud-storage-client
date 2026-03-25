/**
 * Watermark detection page.
 * All processing is local — no file is uploaded to the server.
 * Supports: PDF (invisible text), PNG/JPEG (LSB steganography).
 */
import { useState, useRef, useCallback } from 'react'
import {
  Card,
  Typography,
  Button,
  Spinner,
  Chip
} from '@material-tailwind/react'
import {
  ArrowUpTrayIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
  ClipboardDocumentIcon,
  CheckCircleIcon,
  XCircleIcon
} from '@heroicons/react/24/outline'
import { detectWatermark } from '../watermarkDetector'
import { bytesToSize } from './Types'
import toast from 'react-hot-toast'

const SUPPORTED_EXTS = ['PDF', 'PNG', 'JPG', 'JPEG']
const SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg']

function WatermarkDetectPage() {
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('idle') // idle | detecting | done | error
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  // ── File handling ──────────────────────────────────────────

  function handleFileSelect(selectedFile) {
    if (!selectedFile) return
    const mime = selectedFile.type || ''
    if (!SUPPORTED_MIMES.includes(mime)) {
      toast.error(`不支援的格式：${mime || selectedFile.name.split('.').pop().toUpperCase()}`)
      return
    }
    setFile(selectedFile)
    setStatus('idle')
    setResult(null)
  }

  function handleInputChange(e) {
    handleFileSelect(e.target.files?.[0] || null)
    e.target.value = ''
  }

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    handleFileSelect(e.dataTransfer.files?.[0] || null)
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  function clearFile() {
    setFile(null)
    setStatus('idle')
    setResult(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // ── Detection ──────────────────────────────────────────────

  async function runDetection() {
    if (!file) return
    setStatus('detecting')
    setResult(null)
    try {
      const res = await detectWatermark(file)
      setResult(res)
      setStatus('done')
    } catch (err) {
      setResult({
        fileName: file.name,
        mimeType: file.type,
        detected: false,
        method: 'error',
        reason: err.message
      })
      setStatus('error')
    }
  }

  // ── Copy payload ───────────────────────────────────────────

  function copyPayload() {
    if (!result?.payload) return
    navigator.clipboard.writeText(result.payload).then(() => {
      toast.success('已複製到剪貼板')
    })
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-2xl mx-auto">
      <Typography variant="h4" className="flex items-center gap-2">
        <MagnifyingGlassIcon className="size-6" />
        浮水印偵測
      </Typography>
      <Typography variant="small" color="gray">
        本機偵測，檔案不會上傳至伺服器。支援格式：{SUPPORTED_EXTS.join('、')}
      </Typography>

      {/* ── Drop zone ── */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !file && inputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3
          py-10 transition-colors cursor-pointer select-none
          ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-blue-gray-200 hover:border-blue-400 hover:bg-blue-gray-50'}
          ${file ? 'cursor-default' : ''}
        `}
      >
        {!file ? (
          <>
            <ArrowUpTrayIcon className="size-10 text-blue-gray-400" />
            <Typography color="blue-gray">拖曳或點擊選擇檔案</Typography>
            <Typography variant="small" color="gray">
              支援：{SUPPORTED_EXTS.join(' / ')}
            </Typography>
          </>
        ) : (
          <FileInfoCard file={file} onClear={clearFile} />
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          className="hidden"
          onChange={handleInputChange}
        />
      </div>

      {/* ── Action buttons ── */}
      {file && (
        <div className="flex gap-3">
          <Button
            variant="gradient"
            color="black"
            className="flex items-center gap-2"
            onClick={runDetection}
            disabled={status === 'detecting'}
          >
            {status === 'detecting' ? (
              <>
                <Spinner className="size-4" />
                偵測中...
              </>
            ) : (
              <>
                <MagnifyingGlassIcon className="size-4" />
                開始偵測
              </>
            )}
          </Button>
          <Button variant="outlined" color="red" onClick={clearFile}>
            <XMarkIcon className="size-4 mr-1 inline" />
            重新選擇
          </Button>
        </div>
      )}

      {/* ── Result card ── */}
      {result && <ResultCard result={result} onCopy={copyPayload} />}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────

function FileInfoCard({ file, onClear }) {
  return (
    <div className="flex flex-col items-center gap-1 w-full px-6">
      <Typography variant="h6" className="truncate max-w-xs">
        {file.name}
      </Typography>
      <div className="flex gap-3">
        <Chip value={file.type || '未知格式'} size="sm" variant="ghost" color="blue" />
        <Chip value={bytesToSize(file.size)} size="sm" variant="ghost" color="gray" />
      </div>
      <Button
        variant="text"
        size="sm"
        color="red"
        className="mt-1 flex items-center gap-1"
        onClick={(e) => {
          e.stopPropagation()
          onClear()
        }}
      >
        <XMarkIcon className="size-4" />
        清除
      </Button>
    </div>
  )
}

function ResultCard({ result, onCopy }) {
  const isUnsupported = result.method === 'unsupported'
  const isError = result.method === 'error'

  return (
    <Card className="p-5 flex flex-col gap-4 border border-blue-gray-100">
      <Typography variant="h5">偵測結果</Typography>

      {/* File summary */}
      <div className="flex flex-wrap gap-2">
        <Chip value={result.fileName} size="sm" variant="ghost" color="gray" />
        <Chip value={result.mimeType || '未知'} size="sm" variant="ghost" color="blue" />
      </div>

      {/* Detected / Not detected */}
      {!isUnsupported && !isError && (
        <div className="flex items-center gap-3">
          {result.detected ? (
            <>
              <CheckCircleIcon className="size-7 text-green-600 shrink-0" />
              <Typography color="green" className="font-bold">
                ✅ 偵測到不可視浮水印
              </Typography>
            </>
          ) : (
            <>
              <XCircleIcon className="size-7 text-red-400 shrink-0" />
              <Typography color="red" className="font-bold">
                ❌ 未偵測到不可視浮水印
              </Typography>
            </>
          )}
        </div>
      )}

      {/* Method badge */}
      <div className="flex items-center gap-2">
        <Typography variant="small" color="gray">偵測方法：</Typography>
        <MethodBadge method={result.method} />
      </div>

      {/* Payload */}
      {result.detected && result.payload && (
        <div className="flex flex-col gap-1">
          <Typography variant="small" color="gray">浮水印內容（Payload）：</Typography>
          <div className="relative bg-blue-gray-50 rounded-lg p-3 pr-12 break-all">
            <Typography variant="small" className="font-mono text-blue-gray-800">
              {result.payload}
            </Typography>
            <button
              onClick={onCopy}
              className="absolute top-2 right-2 p-1.5 rounded hover:bg-blue-gray-200 transition-colors"
              title="複製"
            >
              <ClipboardDocumentIcon className="size-4 text-blue-gray-600" />
            </button>
          </div>
        </div>
      )}

      {/* Reason / explanation */}
      {result.reason && (
        <div className="border-t border-blue-gray-50 pt-3">
          <Typography variant="small" color="gray">
            {isError ? '⚠ ' : ''}{result.reason}
          </Typography>
        </div>
      )}

      {/* Unsupported */}
      {isUnsupported && (
        <Typography color="red">此檔案格式不支援浮水印偵測</Typography>
      )}
    </Card>
  )
}

function MethodBadge({ method }) {
  const config = {
    'pdf-invisible-text': { label: 'PDF 不可視文字', color: 'purple' },
    'lsb-r-channel': { label: 'LSB R 通道隱寫', color: 'teal' },
    unsupported: { label: '不支援', color: 'red' },
    error: { label: '錯誤', color: 'red' }
  }
  const { label, color } = config[method] || { label: method, color: 'gray' }
  return <Chip value={label} size="sm" color={color} />
}

export default WatermarkDetectPage
