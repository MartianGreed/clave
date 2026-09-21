import { useEffect, useState } from 'react'
import { DocumentIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  attachmentIssue,
  type AttachmentPreview,
  type ConversationAttachment
} from '../../../../shared/conversation-attachments'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '../ui/dialog'

function AttachmentChip({
  file,
  imagesSupported,
  onRemove,
  onReference
}: {
  file: ConversationAttachment
  imagesSupported: boolean
  onRemove?: () => void
  onReference?: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<AttachmentPreview>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const { id, path, name, mimeType, size, delivery } = file
  const issue = onRemove ? attachmentIssue(file, imagesSupported) : undefined
  useEffect(() => {
    if (!open && !mimeType.startsWith('image/')) return
    let current = true
    void window.electronAPI.conversationFiles
      .preview({ id, path, name, mimeType, size, delivery })
      .then(
        (result) => {
          if (current) {
            setPreview(result)
            setError(undefined)
          }
        },
        (failure) => {
          if (current) setError(String(failure))
        }
      )
    return () => {
      current = false
    }
  }, [id, path, name, mimeType, size, delivery, open])
  return (
    <li className="conversation-attachment" data-error={!!issue}>
      <button
        type="button"
        className="conversation-attachment-preview"
        title={file.path}
        aria-label={`Preview ${file.name}`}
        onClick={() => setOpen(true)}
      >
        {preview?.image ? <img src={preview.image} alt="" /> : <DocumentIcon className="w-4 h-4" />}
        <span>
          <strong>{file.name}</strong>
          <small>
            {onRemove && !issue ? 'Ready · ' : ''}
            {file.delivery === 'image' ? 'Image' : 'File reference'} ·{' '}
            {file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KiB`}
          </small>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="panel-icon-btn"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      )}
      {issue && (
        <div className="conversation-attachment-issue" role="status">
          <p>{issue}</p>
          <button type="button" className="btn-secondary" onClick={onReference}>
            Send as file reference
          </button>
          <p>The agent will receive its path and can try reading it with its tools.</p>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="conversation-attachment-dialog">
          <div className="conversation-attachment-heading">
            <DialogTitle>{file.name}</DialogTitle>
            <DialogClose className="panel-icon-btn" aria-label="Close preview">
              <XMarkIcon className="w-4 h-4" />
            </DialogClose>
          </div>
          <DialogDescription>{file.path}</DialogDescription>
          <div className="conversation-attachment-content">
            {error ? (
              <p role="alert">{error}</p>
            ) : preview ? (
              <>
                {preview.image && <img src={preview.image} alt={file.name} />}
                {preview.text !== undefined && <pre>{preview.text}</pre>}
                {preview.notice && <p>{preview.notice}</p>}
              </>
            ) : (
              <p role="status">Loading preview…</p>
            )}
          </div>
          {onReference && file.delivery === 'image' && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                onReference()
                setOpen(false)
              }}
            >
              Send as file reference
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void window.electronAPI.conversationFiles
                .open(file)
                .catch((failure) => setError(String(failure)))
            }}
          >
            Open file
          </button>
        </DialogContent>
      </Dialog>
    </li>
  )
}
export function ConversationAttachments({
  files,
  imagesSupported = false,
  onChange
}: {
  files: ConversationAttachment[]
  imagesSupported?: boolean
  onChange?: (files: ConversationAttachment[]) => void
}): React.JSX.Element | null {
  if (!files.length) return null
  return (
    <ul
      className="conversation-attachments"
      aria-label={onChange ? 'Attached files' : 'Message attachments'}
    >
      {files.map((file) => (
        <AttachmentChip
          key={file.id}
          file={file}
          imagesSupported={imagesSupported}
          onRemove={
            onChange ? () => onChange(files.filter((item) => item.id !== file.id)) : undefined
          }
          onReference={
            onChange
              ? () =>
                  onChange(
                    files.map((item) =>
                      item.id === file.id ? { ...item, delivery: 'reference' } : item
                    )
                  )
              : undefined
          }
        />
      ))}
    </ul>
  )
}
