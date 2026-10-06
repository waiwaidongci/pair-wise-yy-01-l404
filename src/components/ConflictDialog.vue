<script setup lang="ts">
import { computed } from 'vue'
import type { ConflictChoice } from '../types/form'
import { useDesignerStore } from '../stores/designer'

const store = useDesignerStore()

const visible = computed({
  get: () => store.conflictDialogVisible,
  set: (value: boolean) => {
    if (!value) store.dismissConflictDialog()
    else store.conflictDialogVisible = value
  },
})

function choiceClass(key: string, choice: ConflictChoice): string {
  return store.conflictResolutions[key] === choice ? 'is-choice' : ''
}

function choose(key: string, choice: ConflictChoice) {
  store.resolveConflict(key, choice)
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="字段冲突：检测到另一标签页的改动"
    width="760px"
    :close-on-click-modal="false"
  >
    <div class="conflict-intro">
      系统已按基准版本做字段级合并，下列字段两边都改过且结果不同，保存已被拦下。
      请逐个字段选择保留本标签页或另一标签页的值，未冲突字段已自动合入。
    </div>
    <div v-for="conflict in store.conflicts" :key="conflict.key" class="conflict-item">
      <div class="conflict-label">
        <el-tag size="small" type="danger" effect="plain">{{ conflict.target === 'node' ? '字段' : '表单属性' }}</el-tag>
        <strong>{{ conflict.label }}</strong>
      </div>
      <el-radio-group
        :model-value="store.conflictResolutions[conflict.key]"
        @update:model-value="choose(conflict.key, $event as ConflictChoice)"
      >
        <div class="conflict-sides">
          <el-radio value="local" :class="choiceClass(conflict.key, 'local')">
            <div class="conflict-side">
              <div class="conflict-side-title">本标签页的值</div>
              <pre>{{ conflict.local.deleted ? '（本端已删除该字段）' : conflict.local.text }}</pre>
            </div>
          </el-radio>
          <el-radio value="remote" :class="choiceClass(conflict.key, 'remote')">
            <div class="conflict-side">
              <div class="conflict-side-title">另一标签页的值</div>
              <pre>{{ conflict.remote.deleted ? '（对端已删除该字段）' : conflict.remote.text }}</pre>
            </div>
          </el-radio>
        </div>
      </el-radio-group>
    </div>
    <template #footer>
      <el-button @click="store.dismissConflictDialog()">稍后处理</el-button>
      <el-button type="primary" @click="store.applyConflictResolutions()">按选择合并并保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict-intro {
  margin-bottom: 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.conflict-item {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.conflict-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.conflict-sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
}
.conflict-side pre {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
  font-size: 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 8px;
}
.is-choice .conflict-side {
  outline: 2px solid var(--el-color-primary);
  border-radius: 6px;
}
</style>
