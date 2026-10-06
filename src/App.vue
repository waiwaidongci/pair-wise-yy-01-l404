<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Document, View, Warning } from '@element-plus/icons-vue'
import { useDesignerStore } from './stores/designer'
import ConflictDialog from './components/ConflictDialog.vue'

const route = useRoute()
const router = useRouter()
const store = useDesignerStore()
const activeView = computed(() => route.name === 'preview' ? 'preview' : 'designer')

function switchView(view: string) {
  store.commitDraft()
  router.push(view === 'preview' ? '/preview' : '/')
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
        <el-button v-if="store.hasConflict" size="small" type="warning" @click="store.reopenConflictDialog()">
          {{ store.conflicts.length }} 个字段冲突待处理
        </el-button>
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
    <el-alert
      v-if="store.upgradeError"
      class="upgrade-banner"
      type="error"
      show-icon
      :closable="false"
    >
      <template #title>
        <div class="upgrade-banner-row">
          <span>
            <el-icon style="vertical-align: -2px"><Warning /></el-icon>
            {{ store.upgradeError.message }}，原草稿已保留未被覆盖
            <span v-if="store.upgradeBackupKey">（备份键：{{ store.upgradeBackupKey }}）</span>
            。请检查后点击重试。
          </span>
          <el-button size="small" type="primary" @click="store.retryDraftUpgrade()">重试升级</el-button>
        </div>
      </template>
    </el-alert>
    <main class="app-main">
      <router-view />
    </main>
    <ConflictDialog />
  </div>
</template>

<style scoped>
.upgrade-banner {
  margin: 8px 16px 0;
}
.upgrade-banner-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
