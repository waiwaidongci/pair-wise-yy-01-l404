import { ElMessage } from 'element-plus'
import type { DraftEnvelope, FieldNode, FormSchema, VisibilityCondition } from '../types/form'
import { cloneSchema } from './schema'
import { mergeFormSchemas } from './merge'
import type { ConflictResolutions, MergeConflict } from '../types/form'

export const STORAGE_KEY = 'formcraft-schema-v1'
const BACKUP_KEY_PREFIX = 'formcraft-draft-backup-'
export const DRAFT_VERSION = 2

export class DraftUpgradeError extends Error {
  /** 升级失败的原始草稿，保留以便重试 */
  raw: string
  constructor(raw: string, reason: string) {
    super(`草稿升级失败：${reason}`)
    this.raw = raw
  }
}

function isFormSchema(value: unknown): value is FormSchema {
  const candidate = value as FormSchema | null
  return !!candidate && typeof candidate.title === 'string' && Array.isArray(candidate.nodes)
}

/** 旧版（裸 v1 schema，条件以字段 id 引用）升级为 v2 信封，引用迁移为字段标识 */
export function upgradeDraft(raw: string): DraftEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new DraftUpgradeError(raw, 'JSON 无法解析')
  }

  let schema: FormSchema
  if (
    parsed && typeof parsed === 'object' &&
    (parsed as DraftEnvelope).draftVersion === DRAFT_VERSION
  ) {
    const envelope = parsed as DraftEnvelope
    if (!isFormSchema(envelope.schema) || typeof envelope.revision !== 'number') {
      throw new DraftUpgradeError(raw, 'v2 信封缺少 schema 或 revision')
    }
    schema = envelope.schema
    schema.version = 1
    return { draftVersion: DRAFT_VERSION, revision: envelope.revision, schema }
  }

  if (!isFormSchema(parsed)) {
    throw new DraftUpgradeError(raw, '草稿缺少 title 或 nodes 字段')
  }
  schema = parsed as FormSchema

  const idToName = new Map<string, string>()
  const walk = (nodes: FieldNode[]) => nodes.forEach((node) => {
    idToName.set(node.id, node.name)
    walk(node.children ?? [])
  })
  walk(schema.nodes)

  // id 引用 -> 标识引用；原字段已不存在时置空（联动直接失效，等待用户重新选择）
  const migrateCondition = (nodes: FieldNode[]) => nodes.forEach((node) => {
    const legacy = node.condition as (VisibilityCondition & { fieldId?: string }) | undefined
    if (legacy) {
      const sourceName = legacy.fieldName ?? (legacy.fieldId ? idToName.get(legacy.fieldId) : undefined)
      if (sourceName) {
        node.condition = { fieldName: sourceName, operator: legacy.operator, value: legacy.value }
      } else {
        node.condition = undefined
      }
    }
    migrateCondition(node.children ?? [])
  })
  migrateCondition(schema.nodes)

  schema.version = 1
  return { draftVersion: DRAFT_VERSION, revision: 0, schema }
}

function readEnvelope(): DraftEnvelope | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  return upgradeDraft(raw)
}

function writeEnvelope(envelope: DraftEnvelope) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
}

function backupRaw(raw: string) {
  const key = `${BACKUP_KEY_PREFIX}${Date.now()}`
  try {
    localStorage.setItem(key, raw)
  } catch {
    // 存储不可用时仍然把原文保留在内存中（挂在错误对象上）
  }
  return key
}

export interface LoadedDraft {
  envelope: DraftEnvelope | null
  upgradeError: DraftUpgradeError | null
  backupKey: string | null
}

/** 启动时加载：升级失败则保留原草稿（另存备份键），主草稿不动，等待用户重试 */
export function loadDraft(starter: () => FormSchema): LoadedDraft {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { envelope: null, upgradeError: null, backupKey: null }
  }
  if (!raw) return { envelope: null, upgradeError: null, backupKey: null }
  try {
    return { envelope: upgradeDraft(raw), upgradeError: null, backupKey: null }
  } catch (error) {
    const upgradeError = error instanceof DraftUpgradeError ? error : new DraftUpgradeError(raw, '未知错误')
    const backupKey = backupRaw(raw)
    ElMessage.error({ message: '本地草稿升级失败，已保留原草稿，可点击重试', duration: 4000 })
    return { envelope: null, upgradeError, backupKey }
  }
}

/** 升级失败后重试：仍失败则继续保留原稿，成功则写入主草稿 */
export function retryUpgrade(upgradeError: DraftUpgradeError): DraftEnvelope {
  const envelope = upgradeDraft(upgradeError.raw)
  writeEnvelope(envelope)
  return envelope
}

export interface PersistOutcome {
  status: 'saved' | 'conflict' | 'error'
  envelope?: DraftEnvelope
  conflicts: MergeConflict[]
  remote: DraftEnvelope | null
  message: string
}

/**
 * 以基准版本（baseRevision/baseSchema）保存本地草稿：
 * - 远端未改动：直接写入并推进 revision；
 * - 远端已改动：字段级三方合并，无冲突才落盘，冲突字段拦下并返回两边值；
 * - 远端草稿损坏（升级失败）：按错误处理，绝不整份覆盖。
 */
export function persistDraft(params: {
  local: FormSchema
  baseRevision: number
  baseSchema: FormSchema
  resolutions?: ConflictResolutions
}): PersistOutcome {
  const { local, baseRevision, baseSchema, resolutions = {} } = params
  let remote: DraftEnvelope | null = null
  try {
    remote = readEnvelope()
  } catch (error) {
    return {
      status: 'error',
      conflicts: [],
      remote: null,
      message: error instanceof Error ? error.message : '无法读取对端草稿，已中止保存',
    }
  }

  if (!remote) {
    const envelope: DraftEnvelope = { draftVersion: DRAFT_VERSION, revision: baseRevision + 1, schema: local }
    writeEnvelope(envelope)
    return { status: 'saved', envelope, conflicts: [], remote: null, message: '草稿已保存' }
  }

  if (remote.revision === baseRevision) {
    const envelope: DraftEnvelope = { draftVersion: DRAFT_VERSION, revision: baseRevision + 1, schema: local }
    writeEnvelope(envelope)
    return { status: 'saved', envelope, conflicts: [], remote: null, message: '草稿已保存' }
  }

  const result = mergeFormSchemas(baseSchema, local, remote.schema, resolutions)
  if (result.conflicts.length > 0) {
    return {
      status: 'conflict',
      conflicts: result.conflicts,
      remote,
      message: `检测到 ${result.conflicts.length} 个字段与另一标签页冲突，已拦下保存`,
    }
  }

  const envelope: DraftEnvelope = {
    draftVersion: DRAFT_VERSION,
    revision: remote.revision + 1,
    schema: result.schema,
  }
  writeEnvelope(envelope)
  return {
    status: 'saved',
    envelope,
    conflicts: [],
    remote,
    message: result.fastForward ? '已自动同步另一标签页的改动' : '已合入另一标签页的字段改动并保存',
  }
}

/** 读取当前信封（storage 事件 / 强制导入时使用），升级失败抛错 */
export function readCurrentEnvelope(): DraftEnvelope | null {
  return readEnvelope()
}

export function forceWrite(schema: FormSchema, revision: number): DraftEnvelope {
  const envelope: DraftEnvelope = { draftVersion: DRAFT_VERSION, revision: revision + 1, schema: cloneSchema(schema) }
  writeEnvelope(envelope)
  return envelope
}

export function createInitialEnvelope(schema: FormSchema): DraftEnvelope {
  return { draftVersion: DRAFT_VERSION, revision: 1, schema: cloneSchema(schema) }
}
