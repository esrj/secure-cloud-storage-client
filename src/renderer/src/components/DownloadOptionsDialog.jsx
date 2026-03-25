/**
 * Dialog for choosing download options (original / watermark).
 * Shown when the user clicks "Download" on any file.
 */
import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Button,
  Input,
  Select,
  Option,
  Typography,
  Checkbox
} from '@material-tailwind/react'
import PropTypes from 'prop-types'

/** Supported MIME types for visible watermark — mirrors WatermarkProcessor.js */
const SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg']

function getMimeFromFilename(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return (
    { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || null
  )
}

const POSITION_LABELS = {
  bottomRight: '右下角',
  bottomLeft: '左下角',
  diagonal: '斜線滿版'
}

function DownloadOptionsDialog({ open, onClose, fileData }) {
  const mime = getMimeFromFilename(fileData?.name)
  const watermarkSupported = SUPPORTED_MIMES.includes(mime)

  const [mode, setMode] = useState('original')
  const [visibleWm, setVisibleWm] = useState(true)
  const [invisibleWm, setInvisibleWm] = useState(false)
  const [customNote, setCustomNote] = useState('')
  const [position, setPosition] = useState('bottomRight')
  const [opacity, setOpacity] = useState(30) // 0–100, sent as /100
  const [fontSize, setFontSize] = useState(14)

  // Reset to original mode if format doesn't support watermark
  useEffect(() => {
    if (open && !watermarkSupported) setMode('original')
  }, [open, watermarkSupported])

  function handleDownload() {
    const effectiveMode = !watermarkSupported ? 'original' : mode
    onClose()
    window.electronAPI.askDownloadFileWithOptions({
      fileId: fileData.fileId,
      mode: effectiveMode,
      watermarkOptions:
        effectiveMode === 'watermark'
          ? {
              visible: visibleWm,
              invisible: invisibleWm,
              customNote: customNote.trim(),
              position,
              opacity: opacity / 100,
              fontSize,
              mimeType: mime
            }
          : null
    })
  }

  return (
    <Dialog
      open={open}
      handler={onClose}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>下載選項</DialogHeader>
      <DialogBody className="flex flex-col gap-4">

        {/* ── Mode selection ── */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="radio"
              name="dlMode"
              checked={mode === 'original'}
              onChange={() => setMode('original')}
            />
            <Typography>原檔下載</Typography>
          </label>

          <label
            className={`flex items-center gap-2 select-none ${
              !watermarkSupported ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <input
              type="radio"
              name="dlMode"
              disabled={!watermarkSupported}
              checked={mode === 'watermark'}
              onChange={() => watermarkSupported && setMode('watermark')}
            />
            <Typography>浮水印下載</Typography>
          </label>

          {!watermarkSupported && mime && (
            <Typography variant="small" color="red" className="ml-6">
              此檔案格式（{mime}）不支援浮水印
            </Typography>
          )}
          {!watermarkSupported && !mime && (
            <Typography variant="small" color="red" className="ml-6">
              此檔案格式不支援浮水印
            </Typography>
          )}
        </div>

        {/* ── Watermark options (only when mode=watermark and supported) ── */}
        {mode === 'watermark' && watermarkSupported && (
          <div className="flex flex-col gap-3 border-t border-gray-200 pt-3">

            {/* Watermark type checkboxes */}
            <div>
              <Typography variant="h6" className="mb-1">浮水印類型</Typography>
              <div className="flex flex-row gap-6 flex-wrap">
                <Checkbox
                  label="可視浮水印"
                  checked={visibleWm}
                  onChange={(e) => setVisibleWm(e.target.checked)}
                  ripple={false}
                />
                <div className="flex flex-col">
                  <Checkbox
                    label="不可視浮水印"
                    checked={invisibleWm}
                    onChange={(e) => setInvisibleWm(e.target.checked)}
                    ripple={false}
                  />
                  {invisibleWm && mime === 'image/jpeg' && (
                    <Typography variant="small" color="amber" className="ml-8 mt-0.5">
                      ⚠ JPEG 為有損格式，不可視浮水印可能在二次壓縮後部分失效，建議使用 PNG。
                    </Typography>
                  )}
                </div>
              </div>
            </div>

            {/* ── Visible watermark settings (position / opacity / font size) ── */}
            {visibleWm && (
              <div className="flex flex-col gap-3 border border-blue-gray-100 rounded-lg p-3">
                <Typography variant="small" className="font-bold text-blue-gray-700">
                  可視浮水印設定
                </Typography>

                {/* Position */}
                <div>
                  <Typography variant="h6" className="mb-1">位置</Typography>
                  <Select
                    value={position}
                    onChange={(v) => setPosition(v)}
                    labelProps={{ className: 'peer-focus:hidden' }}
                    className="focus:!border-t-gray-900"
                  >
                    {Object.entries(POSITION_LABELS).map(([val, label]) => (
                      <Option key={val} value={val}>{label}</Option>
                    ))}
                  </Select>
                </div>

                {/* Opacity slider */}
                <div>
                  <Typography variant="h6">透明度：{opacity}%</Typography>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={5}
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                    className="w-full accent-blue-gray-900"
                  />
                </div>

                {/* Font size slider */}
                <div>
                  <Typography variant="h6">字體大小：{fontSize}px</Typography>
                  <input
                    type="range"
                    min={8}
                    max={48}
                    step={2}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full accent-blue-gray-900"
                  />
                </div>
              </div>
            )}

            {/* Custom note */}
            <Input
              label="自訂備注（選填）"
              labelProps={{ className: 'font-sans peer-focus:hidden' }}
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
              size="md"
              className="focus:!border-t-gray-900"
            />
          </div>
        )}

        {/* ── File info footer ── */}
        <div className="border-t border-gray-100 pt-2">
          <Typography variant="small" color="gray">
            檔案：{fileData?.name || '—'} ｜ 格式：{mime || '未知'} ｜{' '}
            浮水印：{watermarkSupported ? '✓ 支援' : '✗ 不支援'}
          </Typography>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="text" color="red" onClick={onClose} className="mr-2">
          取消
        </Button>
        <Button variant="gradient" color="black" onClick={handleDownload}>
          下載
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

DownloadOptionsDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  fileData: PropTypes.object.isRequired
}

export default DownloadOptionsDialog
