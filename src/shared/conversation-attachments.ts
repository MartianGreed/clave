import { z } from 'zod'

export const MAX_ATTACHMENTS = 10
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const attachmentSchema = z
  .object({
    id: z.string().min(1).max(128),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().nonnegative(),
    delivery: z.enum(['reference', 'image'])
  })
  .strict()
export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS)
export type ConversationAttachment = z.infer<typeof attachmentSchema>
export interface AttachmentSource {
  path?: string
  name?: string
  bytes?: Uint8Array
}
export interface AttachmentPreview {
  image?: string
  text?: string
  notice?: string
}

/** An image fallback must be chosen by the user; it is never automatic. */
export function attachmentIssue(
  file: ConversationAttachment,
  imagesSupported: boolean
): string | undefined {
  if (file.delivery !== 'image') return undefined
  if (!imagesSupported) return 'This provider does not support direct image attachments.'
  if (!IMAGE_MIME_TYPES.includes(file.mimeType)) return 'This image format cannot be sent directly.'
  if (file.size > MAX_IMAGE_BYTES) return 'Direct images must be 5 MiB or smaller.'
  return undefined
}
