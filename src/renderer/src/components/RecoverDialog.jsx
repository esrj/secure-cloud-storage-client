/**
 * This component is a dialog for recover user account
 */
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Input,
  Button,
  Typography
} from '@material-tailwind/react'
import PropTypes from 'prop-types'
import { useState, useContext } from 'react'
import { ProfileContext } from './Contexts'
import toast from 'react-hot-toast'
import { Validators } from './Validator'

function RecoverDialog({ open, setOpen }) {
  const [email, setEmail] = useState('')
  const [emailAuth, setEmailAuth] = useState('')
  const [extraKey, setExtraKey] = useState('')
  const [currentState, setCurrentState] = useState(0)
  const { login } = useContext(ProfileContext)

  function dialogHandler() {
    setOpen(!open)
    setEmail('')
    setEmailAuth('')
    setExtraKey('')
    setCurrentState(0)
  }

  function cancelHandler() {
    dialogHandler()
    toast.error('Recover canceled.')
  }

  function updateHandler() {
    switch (currentState) {
      case 0: // Input email
        {
          const result = Validators.email(email)
          if (!result.valid) {
            toast.error(result.message)
            return
          }
          const askRecoverSecretPromise = window.electronAPI.askRecoverSecret({ email })
          toast.promise(askRecoverSecretPromise, {
            loading: '確認中',
            success: '確認成功',
            error: '確認失敗'
          })
          askRecoverSecretPromise
            .then(() => {
              setCurrentState(currentState + 1)
            })
            .catch((error) => {
              dialogHandler()
              toast.error('Failed to recover secrets.')
            })
        }

        break
      case 1: // Input email auth
        {
          const result = Validators.verificationCode(emailAuth)
          if (!result.valid) {
            toast.error(result.message)
            return
          }
          const sendEmailAuthPromise = window.electronAPI.sendEmailAuth({
            emailAuth
          })
          toast.promise(sendEmailAuthPromise, {
            loading: '驗證中',
            success: '驗證成功',
            error: '驗證失敗'
          })
          sendEmailAuthPromise
            .then(() => {
              setCurrentState(currentState + 1)
            })
            .catch((error) => {
              dialogHandler()
              toast.error('Failed to recover secrets.')
            })
        }

        break
      case 2: // Input extra key
        {
          const result = Validators.password(extraKey)
          if (!result.valid) {
            toast.error(result.message)
            return
          }
          const sendRecoverExtraKeyPromise = window.electronAPI.sendRecoverExtraKey({ extraKey })
          toast.promise(sendRecoverExtraKeyPromise, {
            loading: '解密中',
            success: '解密成功',
            error: '解密失敗'
          })
          sendRecoverExtraKeyPromise
            .then(() => {
              dialogHandler()
              toast.success('Secret recover succeeded')
              // login()
            })
            .catch((error) => {
              dialogHandler()
              toast.error('Failed to recover secrets.')
            })
        }

        break
      default:
        dialogHandler()
        break
    }
  }

  function renderText() {
    switch (currentState) {
      case 0:
        return '輸入電子信箱以復原帳號。'
      case 1:
        return '輸入驗證碼。'
      case 2:
        return '輸入備份使用的密碼。'
      default:
        return ''
    }
  }

  return (
    <Dialog open={open} handler={cancelHandler}>
      <DialogHeader>帳號復原</DialogHeader>
      <DialogBody className="space-y-2">
        <Typography variant="lead">{renderText()}</Typography>

        <Input
          label="電子信箱"
          size="lg"
          value={email}
          error={!Validators.email(email).valid}
          readOnly={currentState != 0}
          onChange={(e) => setEmail(e.target.value)}
        />
        {currentState > 0 && (
          <Input
            label="驗證碼"
            size="lg"
            value={emailAuth}
            error={!Validators.verificationCode(emailAuth).valid}
            readOnly={currentState != 1}
            onChange={(e) => setEmailAuth(e.target.value.trim())}
          />
        )}
        {currentState > 1 && (
          <Input
            label="密碼"
            size="lg"
            error={!Validators.password(extraKey).valid}
            value={extraKey}
            onChange={(e) => setExtraKey(e.target.value)}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="text" color="red" onClick={cancelHandler}>
          取消
        </Button>
        <Button variant="gradient" color="black" onClick={updateHandler}>
          確定
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

RecoverDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  setOpen: PropTypes.func.isRequired
}
export default RecoverDialog
