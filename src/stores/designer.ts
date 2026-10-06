import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import type {
  ConflictChoice,
  ConflictResolutions,
  DraftEnvelope,
  FieldNode,
  FormSchema,
  MergeConflict,
} from '../types/form'
import {
  cloneSchema,
  createField,
  createStarterSchema,
  findNode,
  insertNode,
  moveNode,
  removeNode,
} from '../utils/schema'
import {
  DraftUpgradeError,
  forceWrite,
  loadDraft,
  persistDraft,
  readCurrentEnvelope,
  retryUpgrade,
  STORAGE_KEY,
  upgradeDraft,
} from '../utils/draft'

interface StateShape {
  title: string
  description: string
  nodes: FieldNode[]
}

function stateJson(state: StateShape): string {
  return JSON.stringify({ title: state.title, description: state.description, nodes: state.nodes })
}

export const useDesignerStore = defineStore('designer', () => {
  const starter = createStarterSchema()
  const loaded = loadDraft(() => starter)

  const initial: FormSchema = loaded.envelope?.schema ?? starter
  const title = ref(initial.title)
  const description = ref(initial.description)
  const nodes = ref<FieldNode[]>(cloneSchema(initial.nodes))
  const selectedId = ref<string | null>(nodes.value[0]?.id ?? null)
  const history = ref<FormSchema[]>([])
  const historyIndex = ref(-1)
  const saveState = ref(loaded.envelope ? '草稿已加载' : '新表单，改动将自动保存')
  const revision = ref(loaded.envelope?.revision ?? 1)
  const dirty = ref(false)
  const conflictDialogVisible = ref(false)
  const conflicts = ref<MergeConflict[]>([])
  const conflictResolutions = reactive<ConflictResolutions>({})
  const upgradeError = ref<DraftUpgradeError | null>(loaded.upgradeError)
  const upgradeBackupKey = ref<string | null>(loaded.backupKey)
  let saveTimer: number | undefined

  function baselineSnapshot(): FormSchema {
    return {
      version: 1,
      title: title.value,
      description: description.value,
      nodes: cloneSchema(nodes.value),
      updatedAt: new Date().toISOString(),
    }
  }
  let baseSchema: FormSchema = loaded.envelope
    ? cloneSchema(loaded.envelope.schema)
    : baselineSnapshot()

  if (!loaded.envelope && !loaded.upgradeError) {
    // 首次使用：把示例表单写为基准版本（revision 1）
    const envelope = forceWrite(baseSchema, 0)
    revision.value = envelope.revision
    baseSchema = cloneSchema(envelope.schema)
  }

  const selectedNode = computed(() => selectedId.value ? findNode(nodes.value, selectedId.value) : undefined)
  const flatFields = computed(() => {
    const walk = (items: FieldNode[]): FieldNode[] => items.flatMap((item) => [item, ...walk(item.children ?? [])])
    return walk(nodes.value).filter((item) => ['input', 'select', 'date'].includes(item.type))
  })
  const fieldNames = computed(() => {
    const names = new Set<string>()
    const collect = (items: FieldNode[]): void => items.forEach((item) => {
      names.add(item.name)
      collect(item.children ?? [])
    })
    collect(nodes.value)
    return names
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
  const hasConflict = computed(() => conflicts.value.length > 0)

  function matchesBase(): boolean {
    return stateJson({ title: title.value, description: description.value, nodes: nodes.value })
      === stateJson({ title: baseSchema.title, description: baseSchema.description, nodes: baseSchema.nodes })
  }

  function markDirty(message: string) {
    dirty.value = true
    saveState.value = message
    schedulePersist()
  }

  function adoptEnvelope(envelope: DraftEnvelope, recordMergedCheckpoint: boolean) {
    const incoming = envelope.schema
    const same = stateJson({ title: title.value, description: description.value, nodes: nodes.value })
      === stateJson({ title: incoming.title, description: incoming.description, nodes: incoming.nodes })
    if (!same) {
      title.value = incoming.title
      description.value = incoming.description
      nodes.value = cloneSchema(incoming.nodes)
      if (!findNode(nodes.value, selectedId.value ?? '')) selectedId.value = nodes.value[0]?.id ?? null
      if (recordMergedCheckpoint) recordHistory()
    }
    baseSchema = cloneSchema(incoming)
    revision.value = envelope.revision
  }

  function schedulePersist() {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void flushPersist()
    }, 350)
  }

  function flushPersist(): boolean {
    if (upgradeError.value) {
      saveState.value = '草稿升级失败，待重试后才能保存'
      return false
    }
    if (!dirty.value && conflicts.value.length === 0) return true

    const outcome = persistDraft({
      local: schema.value,
      baseRevision: revision.value,
      baseSchema,
      resolutions: conflictResolutions,
    })

    if (outcome.status === 'error') {
      saveState.value = outcome.message
      ElMessage.error(outcome.message)
      return false
    }

    if (outcome.status === 'conflict') {
      conflicts.value = outcome.conflicts
      Object.keys(conflictResolutions).forEach((key) => delete conflictResolutions[key])
      conflictDialogVisible.value = true
      saveState.value = outcome.message
      ElMessage.warning(outcome.message)
      return false
    }

    const envelope = outcome.envelope!
    const mergedRemote = !!outcome.remote && outcome.remote.revision >= revision.value
    adoptEnvelope(envelope, mergedRemote)
    dirty.value = false
    conflicts.value = []
    Object.keys(conflictResolutions).forEach((key) => delete conflictResolutions[key])
    saveState.value = `${outcome.message} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    if (mergedRemote) ElMessage.success(outcome.message)
    return true
  }

  /** 冲突弹窗中逐字段选择本端/对端后，应用选择并保存 */
  function resolveConflict(key: string, choice: ConflictChoice) {
    conflictResolutions[key] = choice
  }

  function applyConflictResolutions() {
    const missing = conflicts.value.some((item) => !conflictResolutions[item.key])
    if (missing) {
      ElMessage.warning('还有冲突字段未选择保留哪一侧')
      return
    }
    if (flushPersist()) conflictDialogVisible.value = false
  }

  function dismissConflictDialog() {
    conflictDialogVisible.value = false
  }

  function reopenConflictDialog() {
    if (conflicts.value.length) conflictDialogVisible.value = true
  }

  /** 升级失败后重试：成功则写入主草稿并载入，失败则继续保留原稿 */
  function retryDraftUpgrade() {
    if (!upgradeError.value) return
    try {
      const envelope = retryUpgrade(upgradeError.value)
      adoptEnvelope(envelope, false)
      history.value = []
      historyIndex.value = -1
      recordHistory()
      dirty.value = false
      upgradeError.value = null
      upgradeBackupKey.value = null
      saveState.value = '旧草稿已升级并载入'
      ElMessage.success('草稿升级成功')
    } catch (error) {
      ElMessage.error(error instanceof DraftUpgradeError ? error.message : '草稿升级仍失败，原草稿已保留')
    }
  }

  function recordHistory() {
    const snapshot = cloneSchema(schema.value)
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(snapshot)
    if (history.value.length > 60) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  function commitDraft(message = '变更待保存') {
    if (upgradeError.value) return
    if (matchesBase()) {
      dirty.value = false
      return
    }
    recordHistory()
    markDirty(message)
  }

  function mutate(mutator: (draft: FieldNode[]) => void, message = '画布已更新') {
    if (upgradeError.value) return
    const draft = cloneSchema(nodes.value)
    mutator(draft)
    nodes.value = draft
    recordHistory()
    markDirty(message)
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
      node.condition = { fieldName: '', operator: 'equals', value: '', ...(node.condition ?? {}), ...patch }
      if (patch.fieldName === '') node.condition = undefined
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

  function duplicateNode(node: FieldNode): FieldNode {
    const copy = cloneSchema(node)
    copy.id = createField(copy.type).id
    copy.name = `${copy.name}_copy`
    copy.label = `${copy.label} 副本`
    const walk = (items: FieldNode[]) => items.forEach((item) => {
      item.id = createField(item.type).id
      walk(item.children ?? [])
    })
    walk(copy.children ?? [])
    return copy
  }

  function duplicateSelected() {
    if (!selectedId.value) return
    const source = findNode(nodes.value, selectedId.value)
    if (!source) return
    const copy = duplicateNode(source)
    mutate((draft) => draft.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  function duplicateNodeById(id: string) {
    const source = findNode(nodes.value, id)
    if (!source) return
    const copy = duplicateNode(source)
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
    // 撤销/重做只是回到历史中的既定快照，不另压栈
    markDirty('变更待保存')
  }

  function replaceSchema(next: FormSchema) {
    // 显式导入整份 Schema：以最新 revision 为基准强制写入，导入内容作为新版本
    const remote = readCurrentEnvelope()
    const baseRevision = remote ? remote.revision : revision.value
    const envelope = forceWrite(cloneSchema(next), baseRevision)
    title.value = envelope.schema.title
    description.value = envelope.schema.description
    nodes.value = envelope.schema.nodes
    selectedId.value = nodes.value[0]?.id ?? null
    baseSchema = cloneSchema(envelope.schema)
    revision.value = envelope.revision
    dirty.value = false
    conflicts.value = []
    Object.keys(conflictResolutions).forEach((key) => delete conflictResolutions[key])
    conflictDialogVisible.value = false
    history.value = []
    historyIndex.value = -1
    recordHistory()
    saveState.value = `Schema 已导入并保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  }

  // 跨标签页同步：另一标签页写入 localStorage
  function handleStorageChange(event: StorageEvent) {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    let envelope: DraftEnvelope
    try {
      envelope = upgradeDraft(event.newValue)
    } catch {
      return
    }
    if (envelope.revision <= revision.value) return

    if (conflicts.value.length > 0) {
      // 冲突处理中：不打断弹窗；应用选择保存时 persistDraft 会重新读取最新对端版本再合并
      return
    }
    if (dirty.value) {
      saveState.value = '另一标签页已保存，本次保存将自动合并其字段改动'
      return
    }
    adoptEnvelope(envelope, false)
    history.value = []
    historyIndex.value = -1
    recordHistory()
    saveState.value = '已同步另一标签页的最新草稿'
  }

  window.addEventListener('storage', handleStorageChange)
  recordHistory()

  return {
    title,
    description,
    nodes,
    selectedId,
    selectedNode,
    flatFields,
    fieldNames,
    schema,
    saveState,
    revision,
    dirty,
    conflicts,
    conflictResolutions,
    conflictDialogVisible,
    hasConflict,
    upgradeError,
    upgradeBackupKey,
    canUndo,
    canRedo,
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
    resolveConflict,
    applyConflictResolutions,
    dismissConflictDialog,
    reopenConflictDialog,
    retryDraftUpgrade,
  }
})
