<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Document, View, Warning } from '@element-plus/icons-vue'
import { useDesignerStore } from './stores/designer'
import { findNode } from './utils/schema'
import { formatValue, type Conflict } from './utils/merge'

const route = useRoute()
const router = useRouter()
const store = useDesignerStore()
const activeView = computed(() => route.name === 'preview' ? 'preview' : 'designer')

const conflictDialogVisible = computed(() => store.conflicts.length > 0)

function switchView(view: string) {
  store.commitDraft()
  router.push(view === 'preview' ? '/preview' : '/')
}

function orderLabels(ids: string[]): string {
  return ids.map((id) => findNode(store.nodes, id)?.label ?? id).join(' → ')
}

function conflictTitle(c: Conflict): string {
  if (c.kind === 'property') return c.nodeLabel
  if (c.kind === 'modify-delete') return `${c.nodeLabel}（${c.deletedBy === 'ours' ? '我方删除，对方修改' : '对方删除，我方修改'}）`
  if (c.kind === 'add') return `${c.nodeLabel}（双方新增了同名字段）`
  return `${c.parentLabel}（字段顺序冲突）`
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark">FC</div>
        <div>
          <strong>FormCraft</strong>
          <span>业务表单工作台</span>
        </div>
      </div>
      <div class="header-actions">
        <span class="save-state">{{ store.saveState }}</span>
        <el-tag
          v-if="store.draftLocked"
          type="danger"
          effect="dark"
          style="cursor: pointer"
          @click="store.reopenMigration"
        >
          <el-icon><Warning /></el-icon>
          草稿升级失败，点击重试
        </el-tag>
        <el-tag v-else-if="store.externalUpdate" type="warning" effect="dark">
          其他标签页有更新，保存时将按字段合并
        </el-tag>
        <el-radio-group :model-value="activeView" @change="switchView">
          <el-radio-button value="designer">
            <el-icon><Document /></el-icon>
            设计器
          </el-radio-button>
          <el-radio-button value="preview">
            <el-icon><View /></el-icon>
            实时预览
          </el-radio-button>
        </el-radio-group>
      </div>
    </header>
    <main class="app-main">
      <router-view />
    </main>
  </div>

  <!-- 多标签页字段级合并冲突 -->
  <el-dialog
    v-model="conflictDialogVisible"
    title="检测到标签页冲突"
    width="760px"
    :close-on-click-modal="false"
    :show-close="false"
  >
    <div class="conflict-intro">
      另一个标签页在你编辑期间保存了草稿。以下字段双方都做了修改，请选择保留哪一方的值；裁决后将按基准版本做字段级合并并保存。
    </div>
    <div v-for="c in store.conflicts" :key="c.key" class="conflict-card">
      <div class="conflict-title">{{ conflictTitle(c) }}</div>

      <template v-if="c.kind === 'property'">
        <div class="conflict-prop">{{ c.propertyLabel }}</div>
        <div class="conflict-values">
          <div class="conflict-col">
            <span class="conflict-tag base">基准值</span>
            <pre>{{ formatValue(c.baseValue) }}</pre>
          </div>
          <div class="conflict-col">
            <span class="conflict-tag ours">我方（本标签页）</span>
            <pre>{{ formatValue(c.ourValue) }}</pre>
          </div>
          <div class="conflict-col">
            <span class="conflict-tag theirs">对方（另一标签页）</span>
            <pre>{{ formatValue(c.theirValue) }}</pre>
          </div>
        </div>
      </template>

      <template v-else-if="c.kind === 'modify-delete'">
        <div class="conflict-values">
          <div class="conflict-col">
            <span class="conflict-tag base">基准值</span>
            <pre>{{ formatValue(c.baseValue) }}</pre>
          </div>
          <div class="conflict-col">
            <span class="conflict-tag theirs">修改后的值</span>
            <pre>{{ formatValue(c.modifiedValue) }}</pre>
          </div>
        </div>
      </template>

      <template v-else-if="c.kind === 'add'">
        <div class="conflict-values">
          <div class="conflict-col">
            <span class="conflict-tag ours">我方版本</span>
            <pre>{{ formatValue(c.ourValue) }}</pre>
          </div>
          <div class="conflict-col">
            <span class="conflict-tag theirs">对方版本</span>
            <pre>{{ formatValue(c.theirValue) }}</pre>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="conflict-values">
          <div class="conflict-col">
            <span class="conflict-tag ours">我方顺序</span>
            <pre>{{ orderLabels(c.ourOrder) }}</pre>
          </div>
          <div class="conflict-col">
            <span class="conflict-tag theirs">对方顺序</span>
            <pre>{{ orderLabels(c.theirOrder) }}</pre>
          </div>
        </div>
      </template>

      <el-radio-group v-model="store.pendingResolutions[c.key]" class="conflict-radio">
        <template v-if="c.kind === 'modify-delete'">
          <el-radio value="ours">
            {{ c.deletedBy === 'ours' ? '接受删除（我方删除）' : '保留节点（我方修改）' }}
          </el-radio>
          <el-radio value="theirs">
            {{ c.deletedBy === 'ours' ? '保留节点（对方修改）' : '接受删除（对方删除）' }}
          </el-radio>
        </template>
        <template v-else-if="c.kind === 'order'">
          <el-radio value="ours">使用我方顺序</el-radio>
          <el-radio value="theirs">使用对方顺序</el-radio>
        </template>
        <template v-else>
          <el-radio value="ours">保留我方值</el-radio>
          <el-radio value="theirs">保留对方值</el-radio>
        </template>
      </el-radio-group>
    </div>
    <template #footer>
      <el-button @click="store.cancelConflicts()">取消（不保存）</el-button>
      <el-button type="primary" @click="store.resolveConflicts()">应用选择并合并保存</el-button>
    </template>
  </el-dialog>

  <!-- 旧稿升级失败 -->
  <el-dialog
    v-model="store.migrationDialogVisible"
    title="草稿升级失败"
    width="640px"
    :close-on-click-modal="false"
    :show-close="false"
  >
    <div class="conflict-intro">
      浏览器本机存储中的草稿无法升级到基准版本，<strong>原草稿已保留未改动</strong>。可重试升级；若暂时跳过，将使用示例草稿且暂停保存，直到升级成功。
    </div>
    <el-alert type="error" :title="store.migrationError ?? '未知错误'" :closable="false" style="margin-bottom: 12px" />
    <el-collapse>
      <el-collapse-item title="查看原始草稿内容（保留在本机存储中，未被覆盖）">
        <pre class="raw-draft">{{ store.migrationRaw }}</pre>
      </el-collapse-item>
    </el-collapse>
    <template #footer>
      <el-button @click="store.closeMigration">暂时跳过（保留原草稿）</el-button>
      <el-button type="primary" @click="store.retryMigration">重试升级</el-button>
    </template>
  </el-dialog>
</template>
