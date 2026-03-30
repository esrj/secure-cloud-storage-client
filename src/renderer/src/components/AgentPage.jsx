/**
 * Metadata-only smart search agent chat page.
 *
 * The agent can only see non-sensitive metadata:
 * name, extension, size, date, permission, description, tags.
 * It never receives file content or cryptographic material.
 */
import { useState, useEffect, useRef, useCallback, useContext } from 'react'
import { Input, Button, Typography } from '@material-tailwind/react'
import { PaperAirplaneIcon, TrashIcon } from '@heroicons/react/24/outline'
import AgentMessageBubble from './AgentMessageBubble'
import toast from 'react-hot-toast'
import { parseFileList } from './Types'
import { ProfileContext } from './Contexts'

const WELCOME = {
  id: 'welcome',
  role: 'assistant',
  content:
    '你好！我是智慧搜尋助手。\n\n我可以依據檔名、標籤、分類、日期、大小等 metadata 幫你找到需要的文件。\n\n注意：基於安全設計，只有權限設為「公開」的檔案才可被搜尋。\n\n請問有什麼需要搜尋的嗎？',
  files: [],
  matchCount: 0,
  totalCount: 0
}

export default function AgentPage() {
  const {
    storedNameC: [uploaderName],
    userIdC: [userId]
  } = useContext(ProfileContext)

  const [messages, setMessages] = useState([WELCOME])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [fileList, setFileList] = useState([])
  const scrollRef = useRef(null)
  const isComposingRef = useRef(false)

  // Keep a mutable ref of the latest history for the IPC call
  const historyRef = useRef([])

  // Receive file list updates from the main process (same channel as FileTable)
  useEffect(() => {
    const unsub = window.electronAPI?.onFileListRes?.((result) => {
      try {
        // result.files is already a parsed array (FileManager enriches with tags before sending)
        const parsed = parseFileList(result.files, false)
        setFileList(parsed)
      } catch (e) {
        console.error('[AgentPage] parseFileList error:', e)
      }
    })
    // Request a fresh file list on mount
    void window.electronAPI?.requestFileList?.()
    return () => unsub?.()
  }, [])

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setLoading(true)

    const userMsg = { id: crypto.randomUUID(), role: 'user', content: text }
    const thinkingMsg = { id: 'thinking', role: 'assistant', content: '', isLoading: true }

    setMessages((prev) => [...prev, userMsg, thinkingMsg])

    try {
      const result = await window.electronAPI.agentQuery({
        userMessage: text,
        history: historyRef.current,
        rawFiles: fileList,
        uploaderName: uploaderName ?? ''
      })

      const assistantContent = result.ok
        ? result.summary
        : `搜尋發生錯誤：${result.error ?? '未知錯誤'}。請稍後再試。`

      const assistantMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        files: result.ok ? (result.files ?? []) : [],
        matchCount: result.ok ? (result.matchCount ?? 0) : 0,
        totalCount: result.ok ? (result.totalCount ?? 0) : 0
      }

      // Update history (exclude loading placeholder and welcome message)
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text },
        { role: 'assistant', content: assistantContent }
      ].slice(-12) // keep last 6 exchanges

      setMessages((prev) => [...prev.filter((m) => m.id !== 'thinking'), assistantMsg])
    } catch (e) {
      toast.error(`智慧搜尋失敗：${e.message}`)
      setMessages((prev) => prev.filter((m) => m.id !== 'thinking'))
    } finally {
      setLoading(false)
    }
  }, [input, loading, fileList])

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault()
      void sendMessage()
    }
  }

  function clearChat() {
    setMessages([WELCOME])
    historyRef.current = []
    void window.electronAPI?.requestFileList?.()
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-blue-gray-100 bg-white px-5 py-3">
        <div>
          <Typography variant="h6" className="text-blue-gray-900">
            智慧搜尋助手
          </Typography>
          <Typography variant="small" color="gray" className="text-xs">
            僅搜尋公開（perm=公開）檔案，不讀取內容・可搜尋 {fileList.filter(f => f.perm === 1).length} / {fileList.length} 份
          </Typography>
        </div>
        <button
          onClick={clearChat}
          className="flex items-center gap-1.5 rounded-lg p-2 text-blue-gray-400 hover:bg-blue-gray-50 hover:text-blue-gray-700 transition-colors"
          title="清除對話"
        >
          <TrashIcon className="size-4" />
        </button>
      </div>

      {/* ── Message area ── */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-5 py-4 bg-blue-gray-50/40"
      >
        {messages.map((msg) => (
          <AgentMessageBubble
            key={msg.id}
            role={msg.role}
            content={msg.content}
            files={msg.files}
            matchCount={msg.matchCount}
            totalCount={msg.totalCount}
            isLoading={msg.isLoading ?? false}
            currentUserId={userId ?? ''}
          />
        ))}
      </div>

      {/* ── Input area ── */}
      <div className="shrink-0 border-t border-blue-gray-100 bg-white px-5 py-4">
        <div className="flex h-11 items-stretch gap-2">
          <Input
            placeholder="輸入搜尋需求，例如：找 2024 年後的海軍相關 PDF…"
            labelProps={{ className: 'hidden' }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={handleKeyDown}
            disabled={loading}
            className="flex-1 rounded-xl focus:!border-blue-500"
            containerProps={{ className: '!min-w-0 flex-1 h-full' }}
          />
          <Button
            onClick={() => void sendMessage()}
            disabled={loading || !input.trim()}
            className="h-full w-12 shrink-0 flex items-center justify-center !p-0 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            <PaperAirplaneIcon className="size-5 text-white" />
          </Button>
        </div>
        <Typography variant="small" className="mt-1.5 text-center text-xs text-blue-gray-400">
          Enter 送出・Shift+Enter 換行・僅搜尋已載入的當前資料夾
        </Typography>
      </div>
    </div>
  )
}
