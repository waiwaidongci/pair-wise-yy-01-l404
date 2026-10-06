import type {
  ConflictResolutions,
  FieldNode,
  FormSchema,
  MergeConflict,
} from '../types/form'
import { cloneSchema } from './schema'

interface FlatEntry {
  id: string
  node: FieldNode | undefined
  parentId: string | undefined
}

/** 按深度优先顺序摊平节点树并记录父节点 */
function flattenEntries(nodes: FieldNode[]): FlatEntry[] {
  const entries: FlatEntry[] = []
  const walk = (items: FieldNode[], parentId: string | undefined) => {
    items.forEach((node) => {
      entries.push({ id: node.id, node, parentId })
      walk(node.children ?? [], node.id)
    })
  }
  walk(nodes, undefined)
  return entries
}

function toMap(entries: FlatEntry[]): Map<string, FlatEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]))
}

/** 节点内容签名（不含 children 与归属信息），用于判断字段内容是否被动过 */
function contentSignature(node: FieldNode): string {
  const { id: _id, children: _children, ...content } = node
  return JSON.stringify(content)
}

/** 冲突弹窗里展示的字段值摘要 */
function nodeSummary(node: FieldNode | undefined): string {
  if (!node) return '（已删除）'
  const parts = [`类型：${node.type}`, `标识：${node.name}`, `标题：${node.label}`]
  if (node.children?.length) parts.push(`子字段：${node.children.length} 个`)
  return parts.join('\n')
}

function conflictLabel(kind: 'title' | 'description' | 'node', node?: FieldNode): string {
  if (kind === 'title') return '表单标题'
  if (kind === 'description') return '表单说明'
  return node ? `字段「${node.label}」（标识 ${node.name}）` : '字段'
}

export interface MergeResult {
  schema: FormSchema
  conflicts: MergeConflict[]
  /** 本地完全没有改动时为 fast-forward，可直接采用对端结果 */
  fastForward: boolean
}

/**
 * 以 base 为基准版本做字段级三方合并，分两个阶段：
 * 1) 字段内容 / 存在性：只有一边动过直接采用；两边都改成不同结果（含删除 vs 修改）记为冲突；
 * 2) 同级顺序：不产生冲突，以本端顺序为骨架、按对端相对锚点插入对端新增/重排，两边改动都保留。
 */
export function mergeFormSchemas(
  base: FormSchema,
  local: FormSchema,
  remote: FormSchema,
  resolutions: ConflictResolutions = {},
): MergeResult {
  const baseMap = toMap(flattenEntries(base.nodes))
  const localMap = toMap(flattenEntries(local.nodes))
  const remoteMap = toMap(flattenEntries(remote.nodes))

  const conflicts: MergeConflict[] = []
  // id -> 最终胜出的节点
  const winnerNodes = new Map<string, FieldNode>()
  let localChanged = false
  let remoteChanged = false

  const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()])
  allIds.forEach((id) => {
    const b = baseMap.get(id)
    const l = localMap.get(id)
    const r = remoteMap.get(id)

    const lContentChanged = l && b ? contentSignature(l.node!) !== contentSignature(b.node!) : !!(l) !== !!(b)
    const rContentChanged = r && b ? contentSignature(r.node!) !== contentSignature(b.node!) : !!(r) !== !!(b)
    const lMoved = !!(l && b) && l.parentId !== b.parentId
    const rMoved = !!(r && b) && r.parentId !== b.parentId
    const lDeleted = b && !l
    const rDeleted = b && !r
    if (lContentChanged || lMoved || lDeleted) localChanged = true
    if (rContentChanged || rMoved || rDeleted) remoteChanged = true

    const lActive = lContentChanged || lMoved
    const rActive = rContentChanged || rMoved

    // 一边删除、另一边保留并修改/移动 => 冲突；两边同删则静默一致
    if (lDeleted && r && rActive) {
      const choice = resolutions[`node:${id}`]
      if (choice === 'local') return
      if (choice === 'remote') {
        winnerNodes.set(id, cloneSchema(r.node!))
        return
      }
      conflicts.push({
        key: `node:${id}`,
        target: 'node',
        label: conflictLabel('node', r.node),
        local: { deleted: true, text: '（本端已删除）' },
        remote: { deleted: false, text: nodeSummary(r.node) },
      })
      return
    }
    if (rDeleted && l && lActive) {
      const choice = resolutions[`node:${id}`]
      if (choice === 'local') {
        winnerNodes.set(id, cloneSchema(l.node!))
        return
      }
      if (choice === 'remote') return
      conflicts.push({
        key: `node:${id}`,
        target: 'node',
        label: conflictLabel('node', l.node),
        local: { deleted: false, text: nodeSummary(l.node) },
        remote: { deleted: true, text: '（对端已删除）' },
      })
      return
    }
    if (lDeleted || rDeleted) return

    // 两边都改了内容（位置差异在顺序阶段单独合并，不在此报冲突）
    if (lContentChanged && rContentChanged && contentSignature(l!.node!) !== contentSignature(r!.node!)) {
      const choice = resolutions[`node:${id}`]
      if (choice === 'local') {
        winnerNodes.set(id, cloneSchema(l!.node!))
        return
      }
      if (choice === 'remote') {
        winnerNodes.set(id, cloneSchema(r!.node!))
        return
      }
      conflicts.push({
        key: `node:${id}`,
        target: 'node',
        label: conflictLabel('node', l!.node),
        local: { deleted: false, text: nodeSummary(l!.node) },
        remote: { deleted: false, text: nodeSummary(r!.node) },
      })
      return
    }

    if (lContentChanged) winnerNodes.set(id, cloneSchema(l!.node!))
    else if (rContentChanged) winnerNodes.set(id, cloneSchema(r!.node!))
    else if (l || r) winnerNodes.set(id, cloneSchema((l ?? r)!.node!))
  })

  const mergedNodes = rebuildTree(base.nodes, local.nodes, remote.nodes, winnerNodes, conflicts)

  const merged = cloneSchema(local)
  merged.nodes = mergedNodes
  mergeScalar(merged, base, local, remote, 'title', '表单标题', conflicts, resolutions)
  mergeScalar(merged, base, local, remote, 'description', '表单说明', conflicts, resolutions)
  if (base.title !== local.title || base.description !== local.description) localChanged = true
  if (base.title !== remote.title || base.description !== remote.description) remoteChanged = true
  merged.updatedAt = new Date().toISOString()

  return { schema: merged, conflicts, fastForward: !localChanged && remoteChanged }
}

function mergeScalar(
  merged: FormSchema,
  base: FormSchema,
  local: FormSchema,
  remote: FormSchema,
  key: 'title' | 'description',
  label: string,
  conflicts: MergeConflict[],
  resolutions: ConflictResolutions,
) {
  const bv = base[key]
  const lv = local[key]
  const rv = remote[key]
  const lChanged = lv !== bv
  const rChanged = rv !== bv
  if (lChanged && rChanged && lv !== rv) {
    const choice = resolutions[key]
    if (choice === 'local') {
      merged[key] = lv
      return
    }
    if (choice === 'remote') {
      merged[key] = rv
      return
    }
    conflicts.push({
      key,
      target: key,
      label,
      local: { deleted: false, text: lv || '（空）' },
      remote: { deleted: false, text: rv || '（空）' },
    })
    merged[key] = lv
    return
  }
  merged[key] = lChanged ? lv : rChanged ? rv : bv
}

function directChildren(nodes: FieldNode[], parentId: string | undefined): string[] {
  if (parentId === undefined) return nodes.map((node) => node.id)
  const find = (items: FieldNode[]): FieldNode | undefined => {
    for (const node of items) {
      if (node.id === parentId) return node
      const hit = find(node.children ?? [])
      if (hit) return hit
    }
    return undefined
  }
  return (find(nodes)?.children ?? []).map((node) => node.id)
}

/** 以本端同级顺序为骨架，按对端相对锚点插入对端新增/重排的节点 */
function mergeSiblingOrder(
  localOrder: string[],
  remoteOrder: string[],
  members: Set<string>,
): string[] {
  const result = localOrder.filter((id) => members.has(id))
  const placed = new Set(result)

  remoteOrder.forEach((id) => {
    if (!members.has(id) || placed.has(id)) return
    const remoteIndex = remoteOrder.indexOf(id)
    // 找对端序列里前后最近的、也已在结果中的锚点
    let anchor: string | undefined
    for (let i = remoteIndex - 1; i >= 0; i--) {
      if (placed.has(remoteOrder[i])) { anchor = remoteOrder[i]; break }
    }
    if (anchor !== undefined) {
      result.splice(result.indexOf(anchor) + 1, 0, id)
    } else {
      let after: string | undefined
      for (let i = remoteIndex + 1; i < remoteOrder.length; i++) {
        if (placed.has(remoteOrder[i])) { after = remoteOrder[i]; break }
      }
      if (after !== undefined) result.splice(result.indexOf(after), 0, id)
      else result.push(id)
    }
    placed.add(id)
  })

  // 兜底：本组里因父级被删而提升等原因未出现在任何序列中的存活节点，追加到末尾
  members.forEach((id) => {
    if (!placed.has(id)) { result.push(id); placed.add(id) }
  })
  return result
}

/** 第二阶段：逐父级合并同级顺序并重建树；父节点已删除的存活节点提升到根层 */
function rebuildTree(
  baseNodes: FieldNode[],
  localNodes: FieldNode[],
  remoteNodes: FieldNode[],
  winnerNodes: Map<string, FieldNode>,
  conflicts: MergeConflict[],
): FieldNode[] {
  const unresolved = new Set(conflicts.map((item) => item.key))
  const alive = new Set<string>()
  winnerNodes.forEach((_node, id) => {
    if (!unresolved.has(`node:${id}`)) alive.add(id)
  })

  const localMap = toMap(flattenEntries(localNodes))
  const remoteMap = toMap(flattenEntries(remoteNodes))

  // 每个节点最终父级：本端和对端一致则采用，否则优先本端，父级不存活则提升到根
  const parentOf = new Map<string, string | undefined>()
  alive.forEach((id) => {
    const lp = localMap.get(id)?.parentId
    const rp = remoteMap.get(id)?.parentId
    let parent = lp !== undefined && localMap.has(id) ? lp : rp
    if (lp !== rp) parent = lp ?? rp
    if (parent !== undefined && !alive.has(parent)) parent = undefined
    parentOf.set(id, parent)
  })

  const groups = new Map<string | undefined, string[]>()
  alive.forEach((id) => {
    const parent = parentOf.get(id)
    const list = groups.get(parent) ?? []
    list.push(id)
    groups.set(parent, list)
  })

  const orderOfGroup = (parentId: string | undefined): string[] => {
    const members = new Set(groups.get(parentId) ?? [])
    const filterAlive = (ids: string[]) => ids.filter((id) => members.has(id))
    return mergeSiblingOrder(
      filterAlive(directChildren(localNodes, parentId)),
      filterAlive(directChildren(remoteNodes, parentId)),
      members,
    )
  }

  // 先递归排子级，再组装；根层最后处理
  const buildGroup = (parentId: string | undefined): FieldNode[] =>
    orderOfGroup(parentId).map((id) => {
      const node = cloneSchema(winnerNodes.get(id)!)
      node.children = buildGroup(id)
      return node
    })

  return buildGroup(undefined)
}
