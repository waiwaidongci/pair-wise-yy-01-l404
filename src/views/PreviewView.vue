<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import RuntimeField from '../components/RuntimeField.vue'
import { useDesignerStore } from '../stores/designer'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { evaluateCondition, findInvalidConditionIds, flattenNodes, validateValue } from '../utils/schema'

const store = useDesignerStore()
const values = reactive<RuntimeValueMap>({})
const errors = reactive<Record<string, string>>({})
const submitted = ref(false)

/** 字段 id → 字段标识：联动条件按 id 引用，运行时值按 name 存取 */
const fieldNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  flattenNodes(store.nodes).forEach((node) => {
    if (node.type !== 'group' && node.type !== 'container') map[node.id] = node.name
  })
  return map
})

/** 联动条件指向已移除字段的节点 id */
const invalidIds = computed(() => findInvalidConditionIds(store.nodes))
const invalidDescription = computed(() => `${invalidIds.value.length} 个字段的联动条件指向已被移除的字段，已按始终显示处理，请回到设计器重新选择目标字段。`)

function applyDefaults(nodes: FieldNode[]) {
  nodes.forEach((node) => {
    if (node.type === 'table') {
      if (!(node.name in values)) values[node.name] = []
    } else if (node.defaultValue !== undefined) {
      if (!(node.name in values)) values[node.name] = node.defaultValue
    } else if (node.type !== 'group' && node.type !== 'container') {
      if (!(node.name in values)) values[node.name] = ''
    }
    applyDefaults(node.children ?? [])
  })
}
applyDefaults(store.nodes)

// 其他标签页保存后草稿同步更新时，为新增字段补默认值（不清空已填内容）
watch(() => store.nodes, () => applyDefaults(store.nodes), { deep: true })

const visibleCount = computed(() => {
  const walk = (nodes: FieldNode[]): number => nodes.reduce((count, node) => {
    if (!evaluateCondition(node.condition, fieldNames.value, values)) return count
    return count + 1 + walk(node.children ?? [])
  }, 0)
  return walk(store.nodes)
})

function updateValue(name: string, value: unknown) {
  values[name] = value
}

function updateError(name: string, error: string) {
  if (error) errors[name] = error
  else delete errors[name]
}

function validateAll(nodes: FieldNode[]) {
  let valid = true
  nodes.forEach((node) => {
    if (!evaluateCondition(node.condition, fieldNames.value, values)) return
    if (node.type !== 'group' && node.type !== 'container') {
      const error = validateValue(values[node.name], node.validation)
      if (error) {
        errors[node.name] = error
        valid = false
      }
    }
    if (!validateAll(node.children ?? [])) valid = false
  })
  return valid
}

function submit() {
  Object.keys(errors).forEach((key) => delete errors[key])
  submitted.value = true
  if (!validateAll(store.nodes)) {
    ElMessage.error('表单校验未通过，请检查红色提示')
    return
  }
  ElMessage.success('预览提交成功，数据已生成')
}
</script>

<template>
  <div class="preview-wrap">
    <div class="preview-card">
      <h1>{{ store.title }}</h1>
      <p>{{ store.description }}</p>
      <el-alert
        v-if="invalidIds.length"
        type="error"
        :closable="false"
        title="部分联动条件已失效"
        :description="invalidDescription"
        style="margin-bottom: 16px"
      />
      <RuntimeField
        v-for="node in store.nodes"
        :key="node.id"
        :node="node"
        :field-names="fieldNames"
        :values="values"
        :errors="errors"
        @update="updateValue"
        @error="updateError"
      />
      <el-button type="primary" size="large" @click="submit">提交表单预览</el-button>
      <div class="summary-box">
        当前可见字段：{{ visibleCount }} 个；联动失效：{{ invalidIds.length }} 个；校验错误：{{ Object.keys(errors).length }} 个。
        <span v-if="submitted">最近一次提交已触发完整条件显隐与校验流程。</span>
      </div>
    </div>
  </div>
</template>
