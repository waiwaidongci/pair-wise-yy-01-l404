import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FieldNode, FormSchema } from '../types/form'
import { cloneSchema, createField, createStarterSchema, findNode, insertNode, moveNode, removeNode } from '../utils/schema'
import {
  STORAGE_KEY,
  loadDraftFromStorage,
  writeDraft,
  threeWayMerge,
  type Conflict,
  type ResolutionMap,
  type StoredDraft,
} from '../utils/merge'

function schemaEquals(a: FormSchema, b: FormSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function defaultResolutions(list: Conflict[]): ResolutionMap {
  const map: ResolutionMap = {}
  for (const c of list) map[c.key] = 'ours'
  return map
}

export const useDesignerStore = defineStore('designer', () => {
  const loaded = loadDraftFromStorage()
  const draftLocked = ref(loaded.status === 'corrupt')
  const migrationError = ref<string | null>(loaded.status === 'corrupt' ? loaded.error : null)
  const migrationRaw = ref<string>(loaded.status === 'corrupt' ? loaded.raw : '')
  const migrationDialogVisible = ref(loaded.status === 'corrupt')

  const initial: FormSchema = loaded.status === 'ok' ? loaded.envelope.schema : createStarterSchema()
  const title = ref(initial.title)
  const description = ref(initial.description)
  const nodes = ref<FieldNode[]>(cloneSchema(initial.nodes))
  const selectedId = ref<string | null>(nodes.value[0]?.id ?? null)
  const history = ref<FormSchema[]>([])
  const historyIndex = ref(-1)
  const saveState = ref(
    loaded.status === 'ok'
      ? loaded.migrated
        ? '旧稿已升级补齐基准版本'
        : '草稿已加载'
      : '草稿升级失败，保存已暂停',
  )

  // 基准版本：本标签页当前编辑状态所基于的版本号与快照
  const baseVersion = ref(loaded.status === 'ok' ? loaded.envelope.baseVersion : 0)
  const baseSchema = ref<FormSchema>(cloneSchema(initial))
  const externalUpdate = ref(false)

  // 字段级合并冲突
  const conflicts = ref<Conflict[]>([])
  const pendingResolutions = ref<ResolutionMap>({})
  let pendingMerge: { base: FormSchema; ours: FormSchema; theirs: FormSchema; theirVersion: number } | null = null

  let saveTimer: number | undefined

  const selectedNode = computed(() => selectedId.value ? findNode(nodes.value, selectedId.value) : undefined)
  const flatFields = computed(() => {
    const walk = (items: FieldNode[]): FieldNode[] => items.flatMap((item) => [item, ...walk(item.children ?? [])])
    return walk(nodes.value).filter((item) => ['input', 'select', 'date'].includes(item.type))
  })
  const schema = computed<FormSchema>(() => ({
    version: 1,
    title: title.value,
    description: description.value,
    nodes: cloneSchema(nodes.value),
    updatedAt: new Date().toISOString(),
  }))
  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)

  function savedMessage() {
    return `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  }

  function applyEnvelope(envelope: StoredDraft) {
    title.value = envelope.schema.title
    description.value = envelope.schema.description
    nodes.value = cloneSchema(envelope.schema.nodes)
    if (!findNode(nodes.value, selectedId.value ?? '')) selectedId.value = nodes.value[0]?.id ?? null
    baseSchema.value = cloneSchema(envelope.schema)
    baseVersion.value = envelope.baseVersion
    externalUpdate.value = false
  }

  function resetHistory() {
    history.value = []
    historyIndex.value = -1
    recordHistory()
  }

  function scheduleSave() {
    saveState.value = '正在保存...'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      if (draftLocked.value) {
        saveState.value = '草稿升级失败，已暂停保存（请重试升级）'
        return
      }
      const ours = schema.value
      let raw: string | null = null
      try {
        raw = localStorage.getItem(STORAGE_KEY)
      } catch {
        raw = null
      }
      if (!raw) {
        // 本机无草稿：直接写入基准版本 1
        writeDraft(ours, 1)
        baseSchema.value = cloneSchema(ours)
        baseVersion.value = 1
        externalUpdate.value = false
        saveState.value = savedMessage()
        return
      }
      let stored: StoredDraft
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !('schema' in parsed) && Array.isArray(parsed.nodes)) {
          // 理论上不会再出现的裸稿，按基准版本 1 处理
          stored = { baseVersion: 1, schemaVersion: 1, schema: parsed as FormSchema, savedAt: '' }
        } else {
          stored = parsed as StoredDraft
        }
      } catch {
        saveState.value = '本机草稿损坏，本次未保存（请重试升级）'
        return
      }
      if (stored.baseVersion === baseVersion.value) {
        // 快路径：期间没有其他标签页保存
        const next = writeDraft(ours, baseVersion.value + 1)
        baseSchema.value = cloneSchema(ours)
        baseVersion.value = next.baseVersion
        externalUpdate.value = false
        saveState.value = savedMessage()
        return
      }
      // 其他标签页已保存：按基准版本做字段级三方合并
      const merged = threeWayMerge(baseSchema.value, ours, stored.schema)
      if (merged.conflicts.length) {
        conflicts.value = merged.conflicts
        pendingResolutions.value = defaultResolutions(merged.conflicts)
        pendingMerge = { base: baseSchema.value, ours, theirs: stored.schema, theirVersion: stored.baseVersion }
        saveState.value = '检测到标签页冲突，等待处理'
        return
      }
      const next = writeDraft(merged.schema, stored.baseVersion + 1)
      baseSchema.value = cloneSchema(merged.schema)
      baseVersion.value = next.baseVersion
      externalUpdate.value = false
      saveState.value = savedMessage()
    }, 350)
  }

  /** 按用户裁决合并冲突并保存 */
  function resolveConflicts() {
    if (!pendingMerge) return
    const { base, ours, theirs } = pendingMerge
    const merged = threeWayMerge(base, ours, theirs, pendingResolutions.value)
    // 以本机最新版本号为基准递增，避免覆盖期间其他标签页的再次保存
    let theirVersion = pendingMerge.theirVersion
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.baseVersion === 'number') theirVersion = parsed.baseVersion
      }
    } catch {
      // 忽略读取失败
    }
    const next = writeDraft(merged.schema, theirVersion + 1)
    baseSchema.value = cloneSchema(merged.schema)
    baseVersion.value = next.baseVersion
    conflicts.value = []
    pendingResolutions.value = {}
    pendingMerge = null
    externalUpdate.value = false
    saveState.value = savedMessage()
  }

  function cancelConflicts() {
    conflicts.value = []
    pendingResolutions.value = {}
    pendingMerge = null
    saveState.value = '冲突未解决，草稿未写入本机'
  }

  /** 升级失败后重试：重新读取本机草稿并尝试升级，原草稿保持不动 */
  function retryMigration() {
    const loaded = loadDraftFromStorage()
    if (loaded.status === 'ok') {
      draftLocked.value = false
      migrationError.value = null
      migrationRaw.value = ''
      migrationDialogVisible.value = false
      applyEnvelope(loaded.envelope)
      resetHistory()
      saveState.value = loaded.migrated ? '旧稿已升级补齐基准版本' : '草稿升级完成'
      return
    }
    if (loaded.status === 'empty') {
      draftLocked.value = false
      migrationError.value = null
      migrationRaw.value = ''
      migrationDialogVisible.value = false
      title.value = initial.title
      description.value = initial.description
      nodes.value = cloneSchema(initial.nodes)
      baseSchema.value = cloneSchema(initial)
      baseVersion.value = 0
      resetHistory()
      saveState.value = '草稿已加载'
      return
    }
    migrationError.value = loaded.error
    migrationRaw.value = loaded.raw
    migrationDialogVisible.value = true
  }

  /** 暂时跳过升级：保留损坏草稿不动，保存暂停，可随时重试 */
  function closeMigration() {
    migrationDialogVisible.value = false
    saveState.value = '草稿升级失败，已暂停保存（可点击重试升级）'
  }

  function reopenMigration() {
    migrationDialogVisible.value = true
  }

  /** 其他标签页保存后的本机存储变化：本标签页无未保存改动则直接同步，否则标记待合并 */
  function onStorage(e: StorageEvent) {
    if (e.key !== STORAGE_KEY || draftLocked.value || !e.newValue) return
    let stored: StoredDraft
    try {
      stored = JSON.parse(e.newValue) as StoredDraft
    } catch {
      return
    }
    if (typeof stored.baseVersion !== 'number' || stored.baseVersion <= baseVersion.value) return
    if (schemaEquals(schema.value, baseSchema.value)) {
      applyEnvelope(stored)
      resetHistory()
      saveState.value = '已同步其他标签页的修改'
    } else {
      externalUpdate.value = true
    }
  }
  window.addEventListener('storage', onStorage)

  function recordHistory() {
    const snapshot = cloneSchema(schema.value)
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(snapshot)
    if (history.value.length > 60) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  function commitDraft(message = '变更已保存') {
    recordHistory()
    saveState.value = message
    scheduleSave()
  }

  function mutate(mutator: (draft: FieldNode[]) => void, message = '画布已更新') {
    const draft = cloneSchema(nodes.value)
    mutator(draft)
    nodes.value = draft
    commitDraft(message)
  }

  function addField(type: FieldNode['type'], parentId?: string, index?: number) {
    const node = createField(type)
    mutate((draft) => {
      if (!insertNode(draft, node, parentId, index)) draft.push(node)
    }, `已添加${node.label}`)
    selectedId.value = node.id
  }

  function addNodeInstance(node: FieldNode, parentId?: string, index?: number) {
    const cloned = cloneSchema(node)
    cloned.id = createField(node.type).id
    const normalizeChildren = (children: FieldNode[] = []) => children.forEach((child) => {
      child.id = createField(child.type).id
      normalizeChildren(child.children)
    })
    normalizeChildren(cloned.children)
    mutate((draft) => insertNode(draft, cloned, parentId, index), '组件已放入画布')
    selectedId.value = cloned.id
  }

  function updateSelected(patch: Partial<FieldNode>) {
    if (!selectedId.value) return
    mutate((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (node) Object.assign(node, cloneSchema(patch))
    }, '属性已更新')
  }

  function updateValidation(patch: Partial<NonNullable<FieldNode['validation']>>) {
    if (!selectedId.value) return
    mutate((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (node) node.validation = { ...(node.validation ?? { required: false }), ...patch }
    }, '校验规则已更新')
  }

  function updateCondition(patch: Partial<NonNullable<FieldNode['condition']>>) {
    if (!selectedId.value) return
    mutate((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (!node) return
      node.condition = { fieldId: '', operator: 'equals', value: '', ...(node.condition ?? {}), ...patch }
      if (patch.fieldId === '') node.condition = undefined
    }, '联动条件已更新')
  }

  function moveNodeTo(sourceId: string, parentId?: string, index = 0) {
    mutate((draft) => moveNode(draft, sourceId, parentId, index), '节点顺序已调整')
  }

  function removeSelected() {
    if (!selectedId.value) return
    mutate((draft) => removeNode(draft, selectedId.value!), '节点已删除')
    selectedId.value = nodes.value[0]?.id ?? null
  }

  function removeNodeById(id: string) {
    mutate((draft) => removeNode(draft, id), '节点已删除')
    if (selectedId.value === id) selectedId.value = nodes.value[0]?.id ?? null
  }

  function duplicateSelected() {
    if (!selectedId.value) return
    const source = findNode(nodes.value, selectedId.value)
    if (!source) return
    const copy = cloneSchema(source)
    copy.id = createField(copy.type).id
    copy.name = `${copy.name}_copy`
    copy.label = `${copy.label} 副本`
    const walk = (items: FieldNode[]) => items.forEach((item) => {
      item.id = createField(item.type).id
      walk(item.children ?? [])
    })
    walk(copy.children ?? [])
    mutate((draft) => draft.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  function duplicateNodeById(id: string) {
    const source = findNode(nodes.value, id)
    if (!source) return
    const copy = cloneSchema(source)
    copy.id = createField(copy.type).id
    copy.name = `${copy.name}_copy`
    copy.label = `${copy.label} 副本`
    const walk = (items: FieldNode[]) => items.forEach((item) => {
      item.id = createField(item.type).id
      walk(item.children ?? [])
    })
    walk(copy.children ?? [])
    mutate((draft) => draft.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  function undo() {
    if (!canUndo.value) return
    historyIndex.value -= 1
    applySnapshot(history.value[historyIndex.value])
  }

  function redo() {
    if (!canRedo.value) return
    historyIndex.value += 1
    applySnapshot(history.value[historyIndex.value])
  }

  function applySnapshot(snapshot: FormSchema) {
    title.value = snapshot.title
    description.value = snapshot.description
    nodes.value = cloneSchema(snapshot.nodes)
    if (!findNode(nodes.value, selectedId.value ?? '')) selectedId.value = nodes.value[0]?.id ?? null
    scheduleSave()
  }

  function replaceSchema(next: FormSchema) {
    title.value = next.title
    description.value = next.description
    nodes.value = next.nodes
    selectedId.value = nodes.value[0]?.id ?? null
    resetHistory()
    // 导入视为新基准：版本号在当前草稿基础上递增，其他标签页下次保存时按字段合并
    let version = 0
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.baseVersion === 'number') version = parsed.baseVersion
      }
    } catch {
      // 忽略读取失败
    }
    const envelope = writeDraft(next, version + 1)
    baseSchema.value = cloneSchema(next)
    baseVersion.value = envelope.baseVersion
    externalUpdate.value = false
    saveState.value = '导入草稿已保存'
  }

  recordHistory()

  return {
    title,
    description,
    nodes,
    selectedId,
    selectedNode,
    flatFields,
    schema,
    saveState,
    canUndo,
    canRedo,
    baseVersion,
    externalUpdate,
    draftLocked,
    migrationError,
    migrationRaw,
    migrationDialogVisible,
    conflicts,
    pendingResolutions,
    addField,
    addNodeInstance,
    updateSelected,
    updateValidation,
    updateCondition,
    moveNodeTo,
    removeSelected,
    removeNodeById,
    duplicateSelected,
    duplicateNodeById,
    undo,
    redo,
    replaceSchema,
    commitDraft,
    mutate,
    resolveConflicts,
    cancelConflicts,
    retryMigration,
    closeMigration,
    reopenMigration,
  }
})
