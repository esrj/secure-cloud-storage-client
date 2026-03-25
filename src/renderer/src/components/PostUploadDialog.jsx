/**
 * Dialog shown after upload(s) complete, allowing users to set
 * permission, attributes, tags, and description for the newly uploaded files.
 *
 * Rules:
 *  - If a field is left empty/default, it is NOT sent (no overwrite).
 *  - permission is always sent (user must actively choose).
 *  - description is only sent if non-empty.
 *  - tags are only sent if non-empty.
 *  - selectedAttrs are only stored if non-empty.
 */
import { useState } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Button,
  Input,
  Textarea,
  Typography,
  Select,
  Option
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import ComboBox from './ComboBox'
import { Validators } from './Validator'
import { PermissionType } from './Types'
import toast from 'react-hot-toast'

function PostUploadDialog({ fileIds, onClose }) {
  const [permission, setPermission] = useState('0') // default: private
  const [selectedAttrs, setSelectedAttrs] = useState([])
  const [tags, setTags] = useState('')
  const [desc, setDesc] = useState('')
  const [loading, setLoading] = useState(false)

  const isMultiple = fileIds.length > 1

  async function handleApply() {
    // Validate tags
    const tagsResult = Validators.tags(tags)
    if (!tagsResult.valid) {
      toast.error(tagsResult.message)
      return
    }
    // Validate description
    const descResult = Validators.fileDescription(desc)
    if (!descResult.valid) {
      toast.error(descResult.message)
      return
    }

    setLoading(true)
    try {
      const tagList = tags
        .split(' ')
        .filter((t) => t !== '')
        .slice(0, 5)

      // Send desc as-is (empty string is valid for newly uploaded files)
      const { succeeded, failed } = await window.electronAPI.askBatchUpdateFileDescPerm({
        fileIds,
        desc: desc.trim(),
        perm: parseInt(permission),
        selectedAttrs,
        tags: tagList
      })

      if (failed.length > 0) {
        toast.error(`${failed.length} 個檔案設定失敗`)
      }
      if (succeeded.length > 0) {
        toast.success(`${succeeded.length} 個檔案設定成功`)
      }
    } catch (error) {
      toast.error(`設定失敗：${error.message}`)
    } finally {
      setLoading(false)
      onClose()
    }
  }

  return (
    <Dialog
      open={true}
      handler={() => {
        if (!loading) onClose()
      }}
      className="flex flex-col max-h-screen overflow-auto"
    >
      <DialogHeader>上傳後設定</DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Typography variant="small" className="text-blue-gray-600">
          {isMultiple
            ? `以下設定將套用到剛剛成功上傳的 ${fileIds.length} 個檔案。`
            : '為剛剛上傳的檔案設定權限、屬性、標籤與說明。'}
          <br />
          未填欄位將保持預設值（空）。若不需要設定，請按「略過」。
        </Typography>

        <div>
          <Typography variant="h6" className="mb-1">
            權限
          </Typography>
          <Select
            value={String(permission)}
            onChange={(value) => setPermission(value)}
            labelProps={{ className: 'peer-focus:hidden' }}
            className="focus:!border-t-gray-900"
          >
            {Object.keys(PermissionType).map((key) => (
              <Option key={key} value={String(key)}>
                {PermissionType[key]}
              </Option>
            ))}
          </Select>
        </div>

        <div>
          <Typography variant="h6" className="mb-1">
            屬性
          </Typography>
          <ComboBox selectedAttrs={selectedAttrs} setSelectedAttrs={setSelectedAttrs} />
        </div>

        <div>
          <Typography variant="h6" className="mb-1">
            標籤
          </Typography>
          <Input
            label="最多五個，以空格隔開"
            labelProps={{ className: 'font-sans peer-focus:hidden' }}
            value={tags}
            onChange={(e) => {
              if ((e.target.value.match(/ /g) || []).length < 5)
                setTags(e.target.value.replaceAll(/\s+/g, ' '))
            }}
            error={!Validators.tags(tags).valid}
            size="lg"
            className="grow rounded-none focus:!border-t-gray-900"
          />
        </div>

        <div>
          <Typography variant="h6" className="mb-1">
            檔案說明
          </Typography>
          <Textarea
            label="（選填）"
            labelProps={{ className: 'peer-focus:hidden' }}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            error={!Validators.fileDescription(desc).valid}
            className="focus:!border-t-gray-900"
          />
        </div>
      </DialogBody>

      <DialogFooter>
        <Button
          variant="text"
          color="red"
          onClick={onClose}
          disabled={loading}
          className="mr-2"
        >
          略過
        </Button>
        <Button variant="gradient" color="black" onClick={handleApply} disabled={loading}>
          {loading ? '套用中...' : isMultiple ? '套用到全部' : '套用'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

PostUploadDialog.propTypes = {
  fileIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  onClose: PropTypes.func.isRequired
}

export default PostUploadDialog
