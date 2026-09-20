<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { Location } from "@/types";

const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const rows = ref<Location[]>([]);
const form = reactive({ name: "", parentId: "", notes: "" });
const treeRef = ref();

type TreeNode = Location & { children: TreeNode[] };

// 扁平列表按 parent/sortOrder 返回，这里组装成树供拖拽组件使用
const tree = computed<TreeNode[]>(() => {
  const nodes = new Map<string, TreeNode>(rows.value.map((row) => [row.id, { ...row, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
});

const treeProps = { label: "name", children: "children" };

async function load() {
  loading.value = true;
  try { rows.value = (await request<{ data: Location[] }>("/locations")).data; }
  catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "位置加载失败"); }
  finally { loading.value = false; }
}

function openCreate(parentId = "") {
  editingId.value = null;
  Object.assign(form, { name: "", parentId, notes: "" });
  dialogVisible.value = true;
}
function openEdit(row: Location) {
  editingId.value = row.id;
  Object.assign(form, { name: row.name, notes: row.notes || "" });
  dialogVisible.value = true;
}

async function save() {
  saving.value = true;
  try {
    if (editingId.value) {
      // 名称/备注走 PATCH；层级调整只能通过拖拽的 /move，避免在编辑弹窗里产生循环
      await request(`/locations/${editingId.value}`, { method: "PATCH", body: { name: form.name, notes: form.notes || null } });
    } else {
      await request("/locations", { method: "POST", body: { name: form.name, parentId: form.parentId || null, notes: form.notes || null } });
    }
    ElMessage.success("位置已保存");
    dialogVisible.value = false;
    await load();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "保存失败"); }
  finally { saving.value = false; }
}

async function archive(row: Location) {
  try {
    await ElMessageBox.confirm(`归档位置“${row.name}”？已有批次仍保留历史引用。`, "归档位置", { type: "warning" });
    await request(`/locations/${row.id}/archive`, { method: "POST" });
    await load();
  } catch (error: any) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}

// 判断 target 是否在 node 子树内（含自身），用于前端先挡一道环
function isInSubtree(node: TreeNode, targetId: string): boolean {
  if (node.id === targetId) return true;
  return node.children.some((child) => isInSubtree(child, targetId));
}
function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

function allowDrop(draggingNode: any, dropNode: any, type: "prev" | "inner" | "next"): boolean {
  const draggedTreeNode = draggingNode.data as TreeNode;
  const target: TreeNode = dropNode.data;
  if (type === "inner") {
    if (draggedTreeNode.id === target.id) return false;
    return !isInSubtree(draggedTreeNode, target.id);
  }
  // 放到 target 的前/后：目标父级是 target.parentId；不能把节点放进自己的子树
  if (target.parentId && isInSubtree(draggedTreeNode, target.parentId)) return false;
  return true;
}

// 拖拽结束后由后端决定最终落点；父级变化或环冲突时后端 422/409，回滚视图并刷新
async function onNodeDrop(draggingNode: any, dropNode: any, dropType: "before" | "after" | "inner") {
  const dragged: Location = draggingNode.data;
  const target: TreeNode = dropNode.data;
  const parentId = dropType === "inner" ? target.id : target.parentId;
  let beforeId: string | null = null;
  if (dropType === "before") beforeId = target.id;
  if (dropType === "after") {
    const siblings = parentId ? findNode(tree.value, parentId)?.children ?? [] : tree.value;
    const index = siblings.findIndex((item) => item.id === target.id);
    beforeId = siblings[index + 1]?.id ?? null;
  }
  try {
    await request(`/locations/${dragged.id}/move`, {
      method: "POST",
      body: { parentId, beforeId, version: dragged.version }
    });
    ElMessage.success("位置已移动");
    await load();
  } catch (error) {
    // 并发冲突或防环拒绝：丢弃前端拖拽结果，以后端数据为准，不保留半截层级
    await load();
    ElMessage.error(error instanceof ApiError ? error.message : "移动失败");
  }
}

// 创建位置时不能选自己的子孙作为上级；新增时没有该限制
const parentOptions = computed(() => {
  if (!editingId.value) return rows.value;
  const editing = findNode(tree.value, editingId.value);
  return rows.value.filter((row) => row.id !== editingId.value && !(editing && isInSubtree(editing, row.id)));
});

onMounted(load);
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1>存放位置</h1>
        <p>建立架、柜、抽屉和房间层级，拖拽节点即可移动与排序；不能把位置拖进它自己的子孙。</p>
      </div>
      <el-button type="primary" @click="openCreate()">新增位置</el-button>
    </header>
    <section class="panel" v-loading="loading">
      <el-tree
        ref="treeRef"
        :data="tree"
        :props="treeProps"
        node-key="id"
        default-expand-all
        draggable
        :allow-drop="allowDrop"
        :expand-on-click-node="false"
        @node-drop="onNodeDrop"
      >
        <template #default="{ data }">
          <div class="location-row">
            <span class="location-name">{{ data.name }}</span>
            <el-tag size="small" type="info" effect="plain">有效批次 {{ data.batchCount }}</el-tag>
            <span class="location-notes" v-if="data.notes">{{ data.notes }}</span>
            <span class="location-actions">
              <el-button link type="primary" size="small" @click.stop="openCreate(data.id)">加子位置</el-button>
              <el-button link type="primary" size="small" @click.stop="openEdit(data)">编辑</el-button>
              <el-button link type="danger" size="small" @click.stop="archive(data)">归档</el-button>
            </span>
          </div>
        </template>
      </el-tree>
      <el-empty v-if="!loading && rows.length===0" description="还没有存放位置" />
    </section>
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑位置' : '新增位置'" width="520px">
      <el-form label-position="top">
        <el-form-item label="位置名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item v-if="!editingId" label="上级位置">
          <el-select v-model="form.parentId" clearable style="width:100%">
            <el-option v-for="row in parentOptions" :key="row.id" :value="row.id" :label="row.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.location-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  padding: 2px 0;
}
.location-name {
  font-weight: 500;
}
.location-notes {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.location-actions {
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.15s;
}
:deep(.el-tree-node__content:hover) .location-actions {
  opacity: 1;
}
</style>
