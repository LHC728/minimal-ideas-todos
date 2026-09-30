import { useState } from 'react'
import { recordActions, useConflicts } from '../hooks/useRecords'
import { formatChineseDateTime } from '../utils/time'
import type { ConflictEntry } from '../db/db'
import { Modal } from './Modal'

interface ConflictDialogProps {
  userId: string | null
}

/**
 * 冲突 UI（方案 §50、§52）。
 *
 * 只有真正冲突时才弹，不做 Git diff 界面。
 * 用户完成选择以前，Base / Local / Remote 三个版本一个都不丢（§51）。
 */
export function ConflictDialog({ userId }: ConflictDialogProps) {
  const conflicts = useConflicts(userId)
  const [manual, setManual] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const conflict = conflicts?.[0] as ConflictEntry | undefined
  if (!conflict) return null

  const isDeleteEdit = conflict.kind === 'delete-edit'

  async function decide(choice: 'local' | 'remote' | 'edited') {
    if (!conflict || busy) return
    setBusy(true)
    try {
      await recordActions.resolveConflict(
        conflict.recordId,
        choice,
        choice === 'edited' ? draft : undefined,
      )
      setManual(false)
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        // 不允许直接关掉：必须先裁决，否则三个版本会一直挂着
      }}
      title="需要你确认"
      widthClass="md:max-w-xl"
    >
      <p className="text-[14.5px] leading-6 text-ink-soft">
        {isDeleteEdit
          ? '这条记录已在另一台设备删除，但你在本机修改过它。'
          : '另一台设备也修改了这条记录。请选择要保留的内容。'}
      </p>

      <div className="mt-4 space-y-3">
        <ConflictVersion
          label={isDeleteEdit ? '本机修改的内容' : '本机版本'}
          content={conflict.local.content}
          time={formatChineseDateTime(conflict.local.updatedAtUtc, conflict.local.updatedTimezone)}
          tone="local"
        />

        {isDeleteEdit ? (
          <div className="rounded-xl border border-line bg-canvas px-3.5 py-3">
            <div className="text-[12px] text-ink-soft">另一台设备</div>
            <div className="mt-1 text-[14.5px] text-ink-soft">已删除这条记录</div>
          </div>
        ) : (
          <ConflictVersion
            label="另一设备版本"
            content={conflict.remote.content}
            time={formatChineseDateTime(conflict.remote.updatedAtUtc, conflict.remote.updatedTimezone)}
            tone="remote"
          />
        )}
      </div>

      {manual ? (
        <div className="mt-4">
          <label className="text-[12.5px] text-ink-soft" htmlFor="conflict-manual">
            手动编辑后保存
          </label>
          <textarea
            id="conflict-manual"
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            className="mt-1.5 w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] leading-[1.55] text-ink outline-none focus:border-idea/40"
          />
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {isDeleteEdit ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide('local')}
              data-testid="conflict-keep-edit"
              className="tap tap-active h-10 rounded-xl bg-idea px-4 text-[14.5px] font-medium text-white disabled:opacity-50"
            >
              恢复并保留本机内容
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide('remote')}
              data-testid="conflict-keep-delete"
              className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
            >
              保留删除
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide('local')}
              data-testid="conflict-keep-local"
              className="tap tap-active h-10 rounded-xl bg-idea px-4 text-[14.5px] font-medium text-white disabled:opacity-50"
            >
              保留本机
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide('remote')}
              data-testid="conflict-keep-remote"
              className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
            >
              保留另一设备
            </button>
            {manual ? (
              <button
                type="button"
                disabled={busy || draft.trim().length === 0}
                onClick={() => void decide('edited')}
                data-testid="conflict-save-manual"
                className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
              >
                保存手动内容
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(conflict.local.content)
                  setManual(true)
                }}
                className="tap tap-active h-10 rounded-xl px-3 text-[14.5px] text-ink-soft"
              >
                手动编辑
              </button>
            )}
          </>
        )}
      </div>

      <p className="mt-4 text-[12.5px] leading-5 text-ink-soft">
        两个版本都仍然保存在本机，在你做出选择之前不会丢失。
        {conflicts && conflicts.length > 1 ? ` 还有 ${conflicts.length - 1} 条待处理。` : ''}
      </p>
    </Modal>
  )
}

function ConflictVersion({
  label,
  content,
  time,
  tone,
}: {
  label: string
  content: string
  time: string
  tone: 'local' | 'remote'
}) {
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${
        tone === 'local' ? 'border-idea/25 bg-idea-soft' : 'border-line bg-canvas'
      }`}
    >
      <div className="text-[12px] text-ink-soft">{label}</div>
      <div className="mt-1 whitespace-pre-wrap break-words text-[14.5px] leading-[1.55] text-ink">
        {content || '（空）'}
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-soft">{time}</div>
    </div>
  )
}
