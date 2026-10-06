export type FieldType = 'input' | 'select' | 'date' | 'table' | 'group' | 'container'
export type ConditionOperator = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan'

export interface TableColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'date'
}

export interface ValidationRule {
  required: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  message?: string
}

export interface VisibilityCondition {
  /** 以字段标识（FieldNode.name）作为引用键，标识改动或字段移除后即为无效引用 */
  fieldName: string
  operator: ConditionOperator
  value: string | number
}

export interface FieldNode {
  id: string
  type: FieldType
  label: string
  name: string
  placeholder?: string
  defaultValue?: unknown
  options?: string[]
  columns?: TableColumn[]
  validation?: ValidationRule
  condition?: VisibilityCondition
  children?: FieldNode[]
}

export interface FormSchema {
  version: 1
  title: string
  description: string
  nodes: FieldNode[]
  updatedAt: string
}

export interface RuntimeValueMap {
  [key: string]: unknown
}

/** localStorage 中的草稿信封：schema 本体 + 单调递增的修订号，用于多标签页三方合并 */
export interface DraftEnvelope {
  draftVersion: 2
  revision: number
  schema: FormSchema
}

export type ConflictTarget = 'title' | 'description' | 'node'
export type ConflictChoice = 'local' | 'remote'

export interface ConflictSide {
  /** 该侧是否已把对应字段删除 */
  deleted: boolean
  /** 供冲突弹窗展示的该侧值摘要 */
  text: string
}

export interface MergeConflict {
  /** title / description / node:<id> */
  key: string
  target: ConflictTarget
  /** 冲突字段的人类可读名称 */
  label: string
  local: ConflictSide
  remote: ConflictSide
}

export type ConflictResolutions = Record<string, ConflictChoice>
