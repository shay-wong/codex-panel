import { memo, useEffect, useState, type ClipboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { attachmentContentUrl } from "../api";
import { postEmbeddedHostMessage } from "../embeddedHost.mjs";
import { useTaskboardI18n } from "../i18n";
import type { Attachment, Task, TaskRelationSummary } from "../types";
import { STATUS_DETAILS } from "./BoardColumn";
import {
  createInlineMediaSegmentsFromHtml,
  parseInternalDocumentUrl,
  writeInlineMediaClipboard,
} from "../documentModel";
import { MarkdownDocument } from "./MarkdownDocument";
import { LinearIcon } from "./LinearIcon";
import { StatusIcon } from "./SemanticIcons";

function referencedTask(
  href: string,
  referenceTasks: Task[],
): { identifier: string; task: Task | null } | null {
  const reference = parseInternalDocumentUrl(href, document.baseURI);
  if (reference?.type !== "issue") return null;
  const { projectId, identifier } = reference;
  const task = referenceTasks.find((candidate) => (
    candidate.projectId === projectId && candidate.identifier === identifier
  )) ?? null;
  return { identifier: task?.externalKey ?? identifier, task };
}

function referencedAttachment(href: string, attachments: Attachment[]): Attachment | null {
  const reference = parseInternalDocumentUrl(href, document.baseURI);
  if (reference?.type !== "attachment" || reference.endpoint !== "download") return null;
  return attachments.find((attachment) => attachment.id === reference.attachmentId) ?? null;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function AttachmentLocalActions({ attachment, onCopy }: {
  attachment: Attachment;
  onCopy: (path: string, announcement: string) => void;
}) {
  const { text } = useTaskboardI18n();
  const [localPath, setLocalPath] = useState<string | null>(null);

  useEffect(() => {
    setLocalPath(null);
    if (new URL(document.baseURI).searchParams.get("host") !== "codex" || window.parent === window) return;
    function receiveLocalPath(event: MessageEvent) {
      if (event.source !== window.parent || event.data?.type !== "panel:attachment-local-path") return;
      const payload = event.data.payload;
      if (payload?.attachmentId !== attachment.id || payload?.filename !== attachment.filename) return;
      setLocalPath(typeof payload.localPath === "string" ? payload.localPath : null);
    }
    function locate() {
      postEmbeddedHostMessage({
        type: "panel:open-attachment",
        payload: { attachmentId: attachment.id, filename: attachment.filename, operation: "local-path" },
      });
    }
    window.addEventListener("message", receiveLocalPath);
    window.addEventListener("focus", locate);
    locate();
    return () => {
      window.removeEventListener("message", receiveLocalPath);
      window.removeEventListener("focus", locate);
    };
  }, [attachment.id, attachment.filename]);

  if (!localPath) return null;
  return (
    <span className="attachment-local-actions">
      <button
        type="button"
        className="icon-button"
        aria-label={text("复制路径", "Copy path")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy(localPath, text("已复制文件路径", "File path copied"));
        }}
      >
        <LinearIcon name="copy" width={16} height={16} />
        <span className="attachment-action-tooltip" role="tooltip">{text("复制路径", "Copy path")}</span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={text("打开", "Open")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          postEmbeddedHostMessage({
            type: "panel:open-attachment",
            payload: { attachmentId: attachment.id, filename: attachment.filename, operation: "reveal" },
          });
        }}
      >
        <LinearIcon name="folder" width={16} height={16} />
        <span className="attachment-action-tooltip" role="tooltip">{text("打开", "Open")}</span>
      </button>
    </span>
  );
}

export const DescriptionDocument = memo(function DescriptionDocument({
  value,
  referenceTasks,
  onOpenTask,
  attachments = [],
  enableImagePreview = false,
  onOpenAttachment,
  onCopyAttachmentPath,
}: {
  value: string;
  referenceTasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
  attachments?: Attachment[];
  enableImagePreview?: boolean;
  onOpenAttachment?: (event: MouseEvent<HTMLAnchorElement>, attachment: Attachment) => void;
  onCopyAttachmentPath?: (path: string, announcement: string) => void;
}) {
  const [previewImage, setPreviewImage] = useState<{
    src: string; alt: string;
  } | null>(null);

  useEffect(() => {
    if (!previewImage) return;
    function closePreview(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPreviewImage(null);
    }
    window.addEventListener("keydown", closePreview, true);
    return () => window.removeEventListener("keydown", closePreview, true);
  }, [previewImage]);

  return (<>
    <MarkdownDocument
      value={value}
      onImageClick={enableImagePreview ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        const src = event.currentTarget.currentSrc || event.currentTarget.src;
        setPreviewImage({
          src,
          alt: event.currentTarget.alt,
        });
      } : undefined}
      onCopy={(event: ClipboardEvent<HTMLDivElement>) => {
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (
          !event.currentTarget.contains(range.startContainer)
          || !event.currentTarget.contains(range.endContainer)
        ) return;
        const selectedRange = range.cloneRange();
        const wrapper = event.currentTarget.ownerDocument.createElement("div");
        wrapper.append(selectedRange.cloneContents());
        const segments = createInlineMediaSegmentsFromHtml(wrapper.innerHTML, referenceTasks);
        if (!segments) return;
        event.preventDefault();
        writeInlineMediaClipboard(
          event.clipboardData,
          segments,
        );
      }}
      renderLink={(href) => {
        const attachment = href ? referencedAttachment(href, attachments) : null;
        if (attachment) {
          if (attachment.contentType.startsWith("video/")) {
            return (
              <video
                className="document-inline-video"
                src={attachmentContentUrl(attachment)}
                aria-label={attachment.filename}
                controls
              />
            );
          }
          return (
            <span className="document-attachment-card">
              <span className="attachment-file-icon" aria-hidden="true">
                <LinearIcon name="file" />
              </span>
              <span className="attachment-copy composer-attachment-copy">
                <strong>{attachment.filename}</strong>
                <span>{fileSize(attachment.size)}</span>
              </span>
            </span>
          );
        }
        const reference = href ? referencedTask(href, referenceTasks) : null;
        if (!reference) return null;
        const { task } = reference;
        if (!task) {
          return (
            <span className="issue-reference-inline">
              <span className="issue-reference-identity">
                <span className="issue-reference-id">{reference.identifier}</span>
              </span>
            </span>
          );
        }
        return (
          <span className={`issue-reference-inline issue-reference-status-${task.status}`}>
            <span className="issue-reference-identity">
              <span className={`status-icon issue-reference-status status-icon-${STATUS_DETAILS[task.status].tone}`}>
                <StatusIcon status={task.status} color="var(--column-status-color)" size={15} />
              </span>
              <span className="issue-reference-id">{task.externalKey ?? task.identifier}</span>
            </span>
            <span className="issue-reference-title">{task.title}</span>
          </span>
        );
      }}
      renderLinkActions={onCopyAttachmentPath ? (href) => {
        const attachment = href ? referencedAttachment(href, attachments) : null;
        return attachment && !attachment.contentType.startsWith("video/") && !attachment.contentType.startsWith("image/")
          ? <AttachmentLocalActions key={attachment.id} attachment={attachment} onCopy={onCopyAttachmentPath} />
          : null;
      } : undefined}
      onLinkClick={(event, href) => {
        const attachment = href ? referencedAttachment(href, attachments) : null;
        if (attachment && onOpenAttachment) {
          if (
            event.button === 0
            && !event.metaKey
            && !event.ctrlKey
            && !event.shiftKey
            && !event.altKey
          ) onOpenAttachment(event, attachment);
          return;
        }
        const reference = href ? referencedTask(href, referenceTasks) : null;
        if (
          !reference
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return;
        event.preventDefault();
        if (reference.task) onOpenTask(reference.task);
      }}
    />
    {previewImage && createPortal(
      <div
        className="display-settings-backdrop image-preview-backdrop"
        role="presentation"
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) setPreviewImage(null);
        }}
      >
        <div
          className="image-preview-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.alt || "Image preview"}
        >
          <img src={previewImage.src} alt={previewImage.alt} />
          <button
            className="icon-button display-settings-close image-preview-close"
            type="button"
            aria-label="Close image preview"
            onClick={() => setPreviewImage(null)}
          >
            <LinearIcon name="close" />
          </button>
        </div>
      </div>,
      document.body,
    )}
  </>);
});
