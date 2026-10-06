import type { FieldNode, FormSchema } from '../types/form'

export const STORAGE_KEY = 'formcraft-schema-v1'
export const SCHEMA_FORMAT_VERSION = 1

/** 写入浏览器本机存储的草稿信封：带基准版本号，用于多标签页字段级合并 */
export interface StoredDraft {
  baseVersion: number
  schemaVersion: number
  schema: FormSchema
  savedAt: string
}

export type Resolution = 'ours' | 'theirs'
export type ResolutionMap = Record<string, Resolution>

export interface PropertyConflict {
  kind: 'property'
  key: string
  nodeId: string
  nodeLabel: string
  property: string
  propertyLabel: string
  baseValue: unknown
  ourValue: unknown
  theirValue: unknown
}

export interface ModifyDeleteConflict {
  kind: 'modify-delete'
  key: string
  nodeId: string
  nodeLabel: string
  /** 删除方：ours = 我方删除对方修改；theirs = 对方删除我方修改 */
  deletedBy: 'ours' | 'theirs'
  baseValue: unknown
  modifiedValue: unknown
}

export interface AddConflict {
  kind: 'add'
  key: string
  nodeId: string
  nodeLabel: string
  ourValue: unknown
  theirValue: unknown
}

export interface OrderConflict {
  kind: 'order'
  key: string
  parentId: string
  parentLabel: string
  ourOrder: string[]
  theirOrder: string[]
}

export type Conflict = PropertyConflict | ModifyDeleteConflict | AddConflict | OrderConflict

interface FlatEntry {
  parentId: string | null
  data: Omit<FieldNode, 'children'>
}

const SCALAR_PROPS = ['label', 'name', 'placeholder', 'defaultValue'] as const
const JSON_PROPS = ['options', 'columns'] as const
const VALIDATION_PROPS = ['required', 'minLength', 'maxLength', 'pattern', 'min', 'max', 'message'] as const
const CONDITION_PROPS = ['fieldId', 'operator', 'value'] as const

export const PROP_LABELS: Record<string, string> = {
  title: '表单标题',
  description: '表单说明',
  label: '显示标题',
  name: '字段标识',
  placeholder: '占位提示',
  defaultValue: '默认值',
  options: '选择项',
  columns: '表格列',
  'validation.required': '校验：必填',
  'validation.minLength': '校验：最小长度',
  'validation.maxLength': '校验：最大长度',
  'validation.pattern': '校验：正则表达式',
  'validation.min': '校验：最小值',
  'validation.max': '校验：最大值',
  'validation.message': '校验：错误提示',
  'condition.fieldId': '联动：目标字段',
  'condition.operator': '联动：判断方式',
  'condition.value': '联动：比较值',
  parentId: '所属分组',
}

export function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '（空）'
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function flattenSchema(schema: FormSchema): Map<string, FlatEntry> {
  const map = new Map<string, FlatEntry>()
  const walk = (nodes: FieldNode[], parentId: string | null) => {
    for (const node of nodes) {
      const { children, ...rest } = node
      map.set(node.id, { parentId, data: rest })
      walk(children ?? [], node.id)
    }
  }
  walk(schema.nodes, null)
  return map
}

function getPath(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur == null ? undefined : (cur as Record<string, unknown>)[key]), data)
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

interface MergeContext {
  resolutions: ResolutionMap
  conflicts: Conflict[]
}

/**
 * 单个属性的三方合并：
 * - 双方都没改 → 取基准
 * - 只有一方改 → 取改的那方
 * - 双方都改且一致 → 取该值
 * - 双方都改且不一致 → 冲突（按 resolutions 裁决，默认保留我方）
 */
function mergeProp(
  ctx: MergeContext,
  nodeId: string,
  nodeLabel: string,
  propPath: string,
  baseV: unknown,
  ourV: unknown,
  theirV: unknown,
  out: Record<string, unknown>,
) {
  const key = `prop:${nodeId}:${propPath}`
  const changedOurs = !jsonEq(ourV, baseV)
  const changedTheirs = !jsonEq(theirV, baseV)
  if (!changedOurs && !changedTheirs) {
    setPath(out, propPath, baseV)
    return
  }
  if (changedOurs && !changedTheirs) {
    setPath(out, propPath, ourV)
    return
  }
  if (!changedOurs && changedTheirs) {
    setPath(out, propPath, theirV)
    return
  }
  if (jsonEq(ourV, theirV)) {
    setPath(out, propPath, ourV)
    return
  }
  const res = ctx.resolutions[key]
  if (res === 'ours') {
    setPath(out, propPath, ourV)
    return
  }
  if (res === 'theirs') {
    setPath(out, propPath, theirV)
    return
  }
  setPath(out, propPath, ourV)
  ctx.conflicts.push({
    kind: 'property',
    key,
    nodeId,
    nodeLabel,
    property: propPath,
    propertyLabel: PROP_LABELS[propPath] ?? propPath,
    baseValue: baseV,
    ourValue: ourV,
    theirValue: theirV,
  })
}

function mergeNode(
  id: string,
  base: FlatEntry | undefined,
  ours: FlatEntry | undefined,
  theirs: FlatEntry | undefined,
  ctx: MergeContext,
): FlatEntry | null {
  // 双方各自新增且 id 相同（极小概率）
  if (!base && ours && theirs) {
    if (jsonEq(ours, theirs)) return ours
    const key = `add:${id}`
    const res = ctx.resolutions[key]
    if (res === 'ours') return ours
    if (res === 'theirs') return theirs
    ctx.conflicts.push({
      kind: 'add',
      key,
      nodeId: id,
      nodeLabel: ours.data.label || theirs.data.label || id,
      ourValue: ours.data,
      theirValue: theirs.data,
    })
    return ours
  }
  // 只有一方新增
  if (!base && ours) return ours
  if (!base && theirs) return theirs
  // 双方都删除
  if (base && !ours && !theirs) return null

  // 我方删除，对方保留/修改
  if (base && !ours && theirs) {
    const untouched = jsonEq(theirs.data, base.data) && jsonEq(theirs.parentId, base.parentId)
    if (untouched) return null
    const key = `del:${id}`
    const res = ctx.resolutions[key]
    if (res === 'ours') return null
    if (res === 'theirs') return theirs
    ctx.conflicts.push({
      kind: 'modify-delete',
      key,
      nodeId: id,
      nodeLabel: base.data.label,
      deletedBy: 'ours',
      baseValue: base.data,
      modifiedValue: theirs.data,
    })
    return theirs
  }
  // 对方删除，我方保留/修改
  if (base && ours && !theirs) {
    const untouched = jsonEq(ours.data, base.data) && jsonEq(ours.parentId, base.parentId)
    if (untouched) return null
    const key = `del:${id}`
    const res = ctx.resolutions[key]
    if (res === 'theirs') return null
    if (res === 'ours') return ours
    ctx.conflicts.push({
      kind: 'modify-delete',
      key,
      nodeId: id,
      nodeLabel: base.data.label,
      deletedBy: 'theirs',
      baseValue: base.data,
      modifiedValue: ours.data,
    })
    return ours
  }

  if (!base || !ours || !theirs) return null

  // 三方都在：逐字段合并
  const merged: Record<string, unknown> = {}
  const label = base.data.label
  for (const prop of SCALAR_PROPS) {
    mergeProp(ctx, id, label, prop, getPath(base.data, prop), getPath(ours.data, prop), getPath(theirs.data, prop), merged)
  }
  for (const prop of JSON_PROPS) {
    mergeProp(ctx, id, label, prop, getPath(base.data, prop), getPath(ours.data, prop), getPath(theirs.data, prop), merged)
  }
  for (const vk of VALIDATION_PROPS) {
    mergeProp(ctx, id, label, `validation.${vk}`, getPath(base.data, `validation.${vk}`), getPath(ours.data, `validation.${vk}`), getPath(theirs.data, `validation.${vk}`), merged)
  }
  for (const ck of CONDITION_PROPS) {
    mergeProp(ctx, id, label, `condition.${ck}`, getPath(base.data, `condition.${ck}`), getPath(ours.data, `condition.${ck}`), getPath(theirs.data, `condition.${ck}`), merged)
  }
  // 所属分组（跨分组拖拽等同于 parentId 字段变更）
  const parentKey = `prop:${id}:parentId`
  const parentChangedOurs = !jsonEq(ours.parentId, base.parentId)
  const parentChangedTheirs = !jsonEq(theirs.parentId, base.parentId)
  let mergedParentId = base.parentId
  if (!parentChangedOurs && !parentChangedTheirs) mergedParentId = base.parentId
  else if (parentChangedOurs && !parentChangedTheirs) mergedParentId = ours.parentId
  else if (!parentChangedOurs && parentChangedTheirs) mergedParentId = theirs.parentId
  else if (jsonEq(ours.parentId, theirs.parentId)) mergedParentId = ours.parentId
  else {
    const res = ctx.resolutions[parentKey]
    if (res === 'ours') mergedParentId = ours.parentId
    else if (res === 'theirs') mergedParentId = theirs.parentId
    else {
      mergedParentId = ours.parentId
      ctx.conflicts.push({
        kind: 'property',
        key: parentKey,
        nodeId: id,
        nodeLabel: label,
        property: 'parentId',
        propertyLabel: PROP_LABELS.parentId,
        baseValue: base.parentId,
        ourValue: ours.parentId,
        theirValue: theirs.parentId,
      })
    }
  }

  merged.id = id
  merged.type = base.data.type
  // 清理：去掉值为 undefined 的键，再删掉空对象
  if (merged.validation && typeof merged.validation === 'object') {
    const v = merged.validation as Record<string, unknown>
    for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k]
    if (Object.keys(v).length === 0) delete merged.validation
  }
  if (merged.condition && typeof merged.condition === 'object') {
    const c = merged.condition as Record<string, unknown>
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k]
    if (Object.keys(c).length === 0) delete merged.condition
  }
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k]
  }
  return { parentId: mergedParentId, data: merged as Omit<FieldNode, 'children'> }
}

/** 双方顺序无冲突时，把对方新增节点按相对位置插入我方顺序 */
function compatibleMerge(ours: string[], theirs: string[]): string[] {
  const result: string[] = []
  let i = 0
  for (const id of theirs) {
    if (ours.indexOf(id) === -1) {
      result.push(id)
      continue
    }
    while (i < ours.length && ours[i] !== id) result.push(ours[i++])
    result.push(id)
    i++
  }
  while (i < ours.length) result.push(ours[i++])
  return result
}

function mergeOrder(
  parentId: string | null,
  baseMap: Map<string, FlatEntry>,
  ourMap: Map<string, FlatEntry>,
  theirMap: Map<string, FlatEntry>,
  mergedMap: Map<string, FlatEntry>,
  ctx: MergeContext,
): string[] {
  const collect = (map: Map<string, FlatEntry>) =>
    [...map.values()].filter((e) => e.parentId === parentId).map((e) => e.data.id)
  const b = collect(baseMap)
  const o = collect(ourMap)
  const t = collect(theirMap)
  const surviving = [...mergedMap.values()].filter((e) => e.parentId === parentId).map((e) => e.data.id)
  const survivingSet = new Set(surviving)
  const bb = b.filter((x) => survivingSet.has(x))
  const oo = o.filter((x) => survivingSet.has(x))
  const tt = t.filter((x) => survivingSet.has(x))

  let order: string[]
  if (jsonEq(oo, bb)) {
    order = tt
  } else if (jsonEq(tt, bb)) {
    order = oo
  } else {
    // 双方都调整过顺序：检查存活节点的相对顺序是否一致
    let inversion = false
    for (let i = 0; i < oo.length && !inversion; i++) {
      for (let j = i + 1; j < oo.length; j++) {
        const xi = tt.indexOf(oo[i])
        const xj = tt.indexOf(oo[j])
        if (xi !== -1 && xj !== -1 && xi > xj) {
          inversion = true
          break
        }
      }
    }
    if (inversion) {
      const key = `order:${parentId ?? 'root'}`
      const res = ctx.resolutions[key]
      if (res === 'theirs') order = tt
      else if (res === 'ours') order = oo
      else {
        const parentEntry = parentId ? mergedMap.get(parentId) : undefined
        ctx.conflicts.push({
          kind: 'order',
          key,
          parentId: parentId ?? '',
          parentLabel: parentId ? (parentEntry?.data.label ?? parentId) : '根节点',
          ourOrder: oo,
          theirOrder: tt,
        })
        order = oo
      }
    } else {
      order = compatibleMerge(oo, tt)
    }
  }

  // 兜底：裁决保留的节点可能不在对方顺序中，确保所有存活节点都有位置
  const present = new Set(order)
  const missing = surviving.filter((id) => !present.has(id))
  return [...order, ...missing]
}

export interface MergeResult {
  conflicts: Conflict[]
  schema: FormSchema
}

/**
 * 以基准版本为底，对“我方（本标签页）”与“对方（本机存储中的最新草稿）”做字段级三方合并。
 * 只合入双方各自改动的字段；双方改了同一字段且不一致时产生冲突，由用户裁决。
 */
export function threeWayMerge(
  base: FormSchema,
  ours: FormSchema,
  theirs: FormSchema,
  resolutions: ResolutionMap = {},
): MergeResult {
  const ctx: MergeContext = { resolutions, conflicts: [] }
  const baseMap = flattenSchema(base)
  const ourMap = flattenSchema(ours)
  const theirMap = flattenSchema(theirs)

  const ids = [...new Set([...baseMap.keys(), ...ourMap.keys(), ...theirMap.keys()])]
  const mergedMap = new Map<string, FlatEntry>()
  for (const id of ids) {
    const entry = mergeNode(id, baseMap.get(id), ourMap.get(id), theirMap.get(id), ctx)
    if (entry) mergedMap.set(id, entry)
  }
  // 父节点被删除但子节点存活时，重挂到根节点
  for (const [id, entry] of mergedMap) {
    if (entry.parentId !== null && !mergedMap.has(entry.parentId)) entry.parentId = null
  }

  // 表单级字段
  const top: Record<string, unknown> = {}
  mergeProp(ctx, '', '表单', 'title', base.title, ours.title, theirs.title, top)
  mergeProp(ctx, '', '表单', 'description', base.description, ours.description, theirs.description, top)

  // 顺序合并
  const parentIds = [...new Set([...mergedMap.values()].map((e) => e.parentId).filter((p): p is string => !!p))]
  const orderMap = new Map<string, string[]>([['', mergeOrder(null, baseMap, ourMap, theirMap, mergedMap, ctx)]])
  for (const pid of parentIds) orderMap.set(pid, mergeOrder(pid, baseMap, ourMap, theirMap, mergedMap, ctx))

  const rebuild = (parentId: string | null): FieldNode[] => {
    const order = orderMap.get(parentId ?? '') ?? []
    return order.map((id) => {
      const entry = mergedMap.get(id)!
      return { ...entry.data, children: rebuild(id) }
    })
  }

  const schema: FormSchema = {
    version: 1,
    title: top.title as string,
    description: top.description as string,
    nodes: rebuild(null),
    updatedAt: new Date().toISOString(),
  }
  return { conflicts: ctx.conflicts, schema }
}

/** 校验草稿 schema 结构是否完整可用 */
export function validateSchema(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return '草稿不是有效对象'
  const s = raw as Record<string, unknown>
  if (typeof s.title !== 'string') return '缺少 title 字段'
  if (!Array.isArray(s.nodes)) return '缺少 nodes 数组'
  const ids = new Set<string>()
  const walk = (nodes: unknown[], path: string): string | null => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i] as Record<string, unknown> | null
      if (!n || typeof n !== 'object') return `${path}[${i}] 不是对象`
      if (typeof n.id !== 'string' || !n.id) return `${path}[${i}] 缺少 id`
      if (ids.has(n.id)) return `${path}[${i}] id 重复：${n.id}`
      ids.add(n.id)
      if (typeof n.type !== 'string') return `${path}[${i}] 缺少 type`
      if (typeof n.label !== 'string') return `${path}[${i}] 缺少 label`
      if (typeof n.name !== 'string') return `${path}[${i}] 缺少 name`
      if (n.validation !== undefined && (typeof n.validation !== 'object' || n.validation === null)) return `${path}[${i}] validation 非法`
      if (n.condition !== undefined) {
        const c = n.condition as Record<string, unknown>
        if (typeof c.fieldId !== 'string' || !c.fieldId) return `${path}[${i}] 联动条件缺少 fieldId`
        if (typeof c.operator !== 'string' || !['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan'].includes(c.operator)) {
          return `${path}[${i}] 联动条件 operator 非法`
        }
      }
      if (n.children !== undefined) {
        if (!Array.isArray(n.children)) return `${path}[${i}] children 不是数组`
        const err = walk(n.children as unknown[], `${path}[${i}].children`)
        if (err) return err
      }
    }
    return null
  }
  return walk(s.nodes as unknown[], 'nodes')
}

export type LoadResult =
  | { status: 'empty' }
  | { status: 'ok'; envelope: StoredDraft; migrated: boolean }
  | { status: 'corrupt'; error: string; raw: string }

/** 读取本机草稿：带基准版本的信封直接解析；旧稿（裸 FormSchema）升级补齐基准版本；损坏时保留原内容 */
export function loadDraftFromStorage(): LoadResult {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch (e) {
    return { status: 'corrupt', error: `无法读取浏览器本机存储：${(e as Error).message}`, raw: '' }
  }
  if (!raw) return { status: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { status: 'corrupt', error: `JSON 解析失败：${(e as Error).message}`, raw }
  }
  if (typeof parsed === 'object' && parsed !== null && 'schema' in parsed) {
    const envelope = parsed as Record<string, unknown>
    if (typeof envelope.schema !== 'object' || envelope.schema === null) return { status: 'corrupt', error: '草稿信封缺少 schema 字段', raw }
    const err = validateSchema(envelope.schema)
    if (err) return { status: 'corrupt', error: `草稿校验失败：${err}`, raw }
    if (typeof envelope.baseVersion !== 'number') return { status: 'corrupt', error: '草稿缺少基准版本号 baseVersion', raw }
    return {
      status: 'ok',
      envelope: {
        baseVersion: envelope.baseVersion,
        schemaVersion: typeof envelope.schemaVersion === 'number' ? envelope.schemaVersion : SCHEMA_FORMAT_VERSION,
        schema: envelope.schema as FormSchema,
        savedAt: typeof envelope.savedAt === 'string' ? envelope.savedAt : '',
      },
      migrated: false,
    }
  }
  // 旧稿：裸 FormSchema，升级补齐基准版本
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).nodes)) {
    const err = validateSchema(parsed)
    if (err) return { status: 'corrupt', error: `旧稿校验失败：${err}`, raw }
    const envelope: StoredDraft = {
      baseVersion: 1,
      schemaVersion: SCHEMA_FORMAT_VERSION,
      schema: parsed as FormSchema,
      savedAt: new Date().toISOString(),
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
    } catch {
      // 写入失败不阻塞使用
    }
    return { status: 'ok', envelope, migrated: true }
  }
  return { status: 'corrupt', error: '无法识别的草稿格式：既不是带基准版本的草稿，也不是旧版表单 Schema', raw }
}

export function writeDraft(schema: FormSchema, baseVersion: number): StoredDraft {
  const envelope: StoredDraft = {
    baseVersion,
    schemaVersion: SCHEMA_FORMAT_VERSION,
    schema,
    savedAt: new Date().toISOString(),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  return envelope
}
