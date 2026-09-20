import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";

/**
 * 库位树结构变更（创建、移动、排序、归档）共用同一把事务级咨询锁，
 * 让任何会改动 parent_id / sort_order 的事务串行执行；
 * 抢不到锁时直接拒绝请求，而不是等待，避免并发移动互相破坏层级。
 */
const LOCATION_TREE_LOCK_KEY = 911_001n;

export async function lockLocationTree(client: DbClient): Promise<void> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1) AS locked",
    [LOCATION_TREE_LOCK_KEY]
  );
  if (!result.rows[0]?.locked) {
    throw new AppError(409, "LOCATION_TREE_BUSY", "库位树正在被其他操作调整，请稍后重试");
  }
}

type LocationRow = {
  id: string;
  name: string;
  parent_id: string | null;
  notes: string | null;
  sort_order: number;
  version: number;
  archived_at: Date | null;
};

export async function loadLocationForUpdate(client: DbClient, id: string): Promise<LocationRow> {
  const result = await client.query<LocationRow>("SELECT * FROM storage_locations WHERE id = $1 FOR UPDATE", [id]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "位置不存在");
  return row;
}

function assertLocationActive(row: LocationRow): void {
  if (row.archived_at) throw new AppError(422, "LOCATION_ARCHIVED", "位置已归档，不能调整层级");
}

async function assertParentExists(client: DbClient, parentId: string): Promise<void> {
  const result = await client.query(
    "SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE",
    [parentId]
  );
  if (!result.rowCount) throw new AppError(422, "INVALID_PARENT", "上级位置不存在或已归档");
}

/**
 * 防环校验：沿着新上级的祖先链向上查找，
 * 若被移动节点出现在链上，挂过去就会形成环。
 * 必须在持有库位树咨询锁、且相关行已锁定后调用，才能挡住并发移动。
 */
async function assertNoCycle(client: DbClient, nodeId: string, newParentId: string): Promise<void> {
  const result = await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM storage_locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.parent_id FROM storage_locations l
         JOIN ancestors a ON l.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = $2`,
    [newParentId, nodeId]
  );
  if (result.rowCount) throw new AppError(422, "LOCATION_CYCLE", "位置层级不能形成循环");
}

async function assertNameAvailable(
  client: DbClient,
  parentId: string | null,
  name: string,
  excludeId?: string
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM storage_locations
      WHERE coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(name) = lower($2)
        AND archived_at IS NULL
        AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 1`,
    [parentId, name, excludeId ?? null]
  );
  if (result.rowCount) throw new AppError(422, "LOCATION_NAME_CONFLICT", "同一上级下已存在同名位置");
}

async function listSiblingIds(client: DbClient, parentId: string | null): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM storage_locations
      WHERE archived_at IS NULL
        AND parent_id IS NOT DISTINCT FROM $1::uuid
      ORDER BY sort_order, name, id`,
    [parentId]
  );
  return result.rows.map((row) => row.id);
}

/**
 * 按给定顺序重排同一父级下的子节点，并把序号压实为 0..n-1。
 * 仅更新序号真正变化的行，避免无谓的版本号递增。
 */
async function renumberSiblings(client: DbClient, orderedIds: string[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await client.query(
      "UPDATE storage_locations SET sort_order = $2, version = version + 1 WHERE id = $1 AND sort_order <> $2",
      [id, index]
    );
  }
}

export async function nextSortOrder(client: DbClient, parentId: string | null): Promise<number> {
  const result = await client.query<{ next: number }>(
    `SELECT coalesce(max(sort_order) + 1, 0) AS next
       FROM storage_locations
      WHERE parent_id IS NOT DISTINCT FROM $1::uuid AND archived_at IS NULL`,
    [parentId]
  );
  return result.rows[0]?.next ?? 0;
}

export async function assertCanCreate(client: DbClient, parentId: string | null, name: string): Promise<void> {
  if (parentId) await assertParentExists(client, parentId);
  await assertNameAvailable(client, parentId, name);
}

export async function assertCanRename(client: DbClient, row: LocationRow, name: string): Promise<void> {
  if (name.toLowerCase() === row.name.toLowerCase()) return;
  await assertNameAvailable(client, row.parent_id, name, row.id);
}

export type MoveOutcome = {
  row: LocationRow;
  moved: boolean;
};

/**
 * 移动节点到 newParentId 下，可指定 beforeId 作为新同级中的插入位置。
 * 整个过程在单事务 + 库位树咨询锁内完成：任何一步失败都会整体回滚，
 * 不会留下 parent_id 已改但 sort_order 断裂的中间状态。
 * 子孙节点不做任何改动——它们仍挂在该节点下，随子树整体移动；
 * 批次通过 batches.location_id 外键引用节点 id，id 不变，引用天然完整。
 */
export async function moveLocation(
  client: DbClient,
  id: string,
  expectedVersion: number,
  newParentId: string | null,
  beforeId?: string | null
): Promise<MoveOutcome> {
  const row = await loadLocationForUpdate(client, id);
  assertLocationActive(row);
  if (row.version !== expectedVersion) {
    throw new AppError(409, "VERSION_CONFLICT", "位置已被其他操作修改，请刷新后重试");
  }
  if (newParentId === id) throw new AppError(422, "LOCATION_CYCLE", "位置不能作为自己的上级");
  if (newParentId) {
    await assertParentExists(client, newParentId);
    await assertNoCycle(client, id, newParentId);
  }

  if (beforeId) {
    if (beforeId === id) throw new AppError(422, "INVALID_BEFORE", "不能把位置排到它自己之前");
    const before = await client.query<{ parent_id: string | null; archived_at: Date | null }>(
      "SELECT parent_id, archived_at FROM storage_locations WHERE id = $1 FOR SHARE",
      [beforeId]
    );
    const beforeRow = before.rows[0];
    if (!beforeRow || beforeRow.archived_at) throw new AppError(422, "INVALID_BEFORE", "插入参考位置不存在或已归档");
    const sameParent =
      beforeRow.parent_id === newParentId ||
      (beforeRow.parent_id === null && newParentId === null);
    if (!sameParent) throw new AppError(422, "INVALID_BEFORE", "插入参考位置不属于目标上级");
  }

  const sameParent = row.parent_id === newParentId || (row.parent_id === null && newParentId === null);
  const targetOrder = sameParent
    ? (await listSiblingIds(client, newParentId)).filter((siblingId) => siblingId !== id)
    : await listSiblingIds(client, newParentId);

  if (beforeId && targetOrder.includes(beforeId)) {
    targetOrder.splice(targetOrder.indexOf(beforeId), 0, id);
  } else {
    targetOrder.push(id);
  }

  const newIndex = targetOrder.indexOf(id);
  const parentChanged = !sameParent;
  const positionChanged = parentChanged || newIndex !== row.sort_order;

  await renumberSiblings(client, targetOrder);

  if (parentChanged) {
    // 离开旧同级组后压实旧组序号
    const oldOrder = (await listSiblingIds(client, row.parent_id)).filter((siblingId) => siblingId !== id);
    await renumberSiblings(client, oldOrder);
  }

  if (!positionChanged) {
    return { row, moved: false };
  }

  await assertNameAvailable(client, newParentId, row.name, id);
  const updated = await client.query<LocationRow>(
    `UPDATE storage_locations
       SET parent_id = $2, sort_order = $3, version = version + 1
     WHERE id = $1 RETURNING *`,
    [id, newParentId, newIndex]
  );
  return { row: updated.rows[0]!, moved: true };
}

/**
 * 对同一父级（parentId 为 null 时是顶级）下的全部子位置整体排序。
 * 请求必须给出与数据库完全一致的同级集合；集合不一致说明有并发的
 * 创建/移动/归档发生，直接拒绝一侧，要求刷新后重试。
 */
export async function reorderLocations(
  client: DbClient,
  parentId: string | null,
  orderedIds: string[]
): Promise<string[]> {
  if (parentId) await assertParentExists(client, parentId);

  const currentIds = await listSiblingIds(client, parentId);
  const sameSet =
    currentIds.length === orderedIds.length &&
    new Set(currentIds).size === new Set([...currentIds, ...orderedIds]).size &&
    new Set(orderedIds).size === orderedIds.length;
  if (!sameSet) {
    throw new AppError(409, "LOCATION_REORDER_STALE", "同级位置已发生变化，请刷新后重新排序");
  }

  await renumberSiblings(client, orderedIds);
  return orderedIds;
}
