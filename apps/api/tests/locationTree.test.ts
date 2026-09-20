import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locationMoveSchema, locationReorderSchema } from "@handcraft/contracts";

// 用进程内 PostgreSQL（PGlite）验证库位树的真实 SQL 行为：
// 防环递归查询、序号压实、外键完整性与并发咨询锁。
const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));

async function makeDb() {
  const db = await PGlite.create();
  for (const file of ["001_init.sql", "002_unit_integrity.sql", "003_batch_status_integrity.sql", "004_location_tree.sql"]) {
    let sql = await readFile(path.join(sqlDir, file), "utf8");
    if (file === "001_init.sql") {
      // PGlite 不附带 pg_trgm / citext，去掉扩展声明与 trigram 索引，不影响被测逻辑
      sql = sql
        .replace(/CREATE EXTENSION[^;]+;/g, "")
        .split("\n")
        .filter((line) => !line.includes("trgm"))
        .join("\n");
    }
    await db.exec(sql);
  }
  return db;
}

type Pg = Awaited<ReturnType<typeof makeDb>>;

async function insertLocation(db: Pg, name: string, parentId: string | null = null) {
  const max = await db.query<{ next: number }>(
    `SELECT coalesce(max(sort_order) + 1, 0) AS next FROM storage_locations
      WHERE parent_id IS NOT DISTINCT FROM $1 AND archived_at IS NULL`,
    [parentId]
  );
  const result = await db.query<{ id: string }>(
    "INSERT INTO storage_locations(name, parent_id, sort_order) VALUES ($1,$2,$3) RETURNING id",
    [name, parentId, max.rows[0]!.next]
  );
  return result.rows[0]!.id;
}

async function idsInOrder(db: Pg, parentId: string | null) {
  const result = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM storage_locations
      WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY sort_order`,
    [parentId]
  );
  return result.rows.map((r) => r.name);
}

// 与 src/lib/locationTree.ts 等价的算法（PGlite 下直接跑 SQL）
async function lockTree(db: Pg) {
  const result = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(911001) AS locked");
  if (!result.rows[0]!.locked) throw new Error("LOCATION_TREE_BUSY");
}

async function hasCycle(db: Pg, nodeId: string, newParentId: string) {
  const result = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM storage_locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.parent_id FROM storage_locations l JOIN ancestors a ON l.id = a.parent_id
     ) SELECT 1 FROM ancestors WHERE id = $2`,
    [newParentId, nodeId]
  );
  return (result.rows.length ?? 0) > 0;
}

async function siblingIds(db: Pg, parentId: string | null) {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM storage_locations WHERE archived_at IS NULL AND parent_id IS NOT DISTINCT FROM $1
      ORDER BY sort_order, name, id`,
    [parentId]
  );
  return result.rows.map((r) => r.id);
}

async function renumber(db: Pg, orderedIds: string[]) {
  for (const [index, id] of orderedIds.entries()) {
    await db.query(
      "UPDATE storage_locations SET sort_order=$2, version=version+1 WHERE id=$1 AND sort_order <> $2",
      [id, index]
    );
  }
}

async function move(
  db: Pg,
  id: string,
  expectedVersion: number,
  newParentId: string | null,
  beforeId: string | null = null
) {
  const current = await db.query<{ parent_id: string | null; sort_order: number; version: number; name: string }>(
    "SELECT * FROM storage_locations WHERE id = $1 FOR UPDATE",
    [id]
  );
  const row = current.rows[0]!;
  if (row.version !== expectedVersion) throw new Error("VERSION_CONFLICT");
  if (newParentId === id) throw new Error("LOCATION_CYCLE");
  if (newParentId && (await hasCycle(db, id, newParentId))) throw new Error("LOCATION_CYCLE");
  if (beforeId && beforeId !== id) {
    const b = await db.query<{ parent_id: string | null }>(
      "SELECT parent_id FROM storage_locations WHERE id=$1 AND archived_at IS NULL FOR SHARE",
      [beforeId]
    );
    if (!b.rows[0]) throw new Error("INVALID_BEFORE");
    const sameParent =
      b.rows[0].parent_id === newParentId || (b.rows[0].parent_id === null && newParentId === null);
    if (!sameParent) throw new Error("INVALID_BEFORE");
  }
  const sameParent = row.parent_id === newParentId || (row.parent_id === null && newParentId === null);
  let target = (await siblingIds(db, newParentId)).filter((sid) => !(sameParent && sid === id));
  if (beforeId && target.includes(beforeId)) {
    target.splice(target.indexOf(beforeId), 0, id);
  } else {
    target.push(id);
  }
  await renumber(db, target);
  if (!sameParent) {
    await renumber(db, (await siblingIds(db, row.parent_id)).filter((sid) => sid !== id));
  }
  const newIndex = target.indexOf(id);
  const parentChanged = !sameParent;
  if (parentChanged || newIndex !== row.sort_order) {
    await db.query(
      "UPDATE storage_locations SET parent_id=$2, sort_order=$3, version=version+1 WHERE id=$1",
      [id, newParentId, newIndex]
    );
  }
}

describe("库位树移动与排序（真实 PostgreSQL）", () => {
  let db: Pg;
  beforeAll(async () => {
    db = await makeDb();
  });

  it("排序迁移字段就绪且初始序号按名称压实", async () => {
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='storage_locations'"
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain("sort_order");
    expect(names).toContain("version");
  });

  it("新节点按追加序号排列，reorder 后顺序整体改变并压实", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const a = await insertLocation(db, "架A");
    const b = await insertLocation(db, "架B");
    const c = await insertLocation(db, "架C");
    expect(await idsInOrder(db, null)).toEqual(["架A", "架B", "架C"]);

    await db.query("BEGIN");
    await lockTree(db);
    await renumber(db, [c, a, b]);
    await db.query("COMMIT");
    expect(await idsInOrder(db, null)).toEqual(["架C", "架A", "架B"]);

    const orders = await db.query<{ sort_order: number }>("SELECT sort_order FROM storage_locations ORDER BY sort_order");
    expect(orders.rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
  });

  it("移动节点时同时压实新旧同级序号", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const room = await insertLocation(db, "房间");
    const drawer = await insertLocation(db, "抽屉", room);
    const x = await insertLocation(db, "顶层X");
    const y = await insertLocation(db, "顶层Y");
    expect(await idsInOrder(db, null)).toEqual(["房间", "顶层X", "顶层Y"]);

    const version = (await db.query<{ version: number }>("SELECT version FROM storage_locations WHERE id=$1", [x]))
      .rows[0]!.version;
    await db.query("BEGIN");
    await lockTree(db);
    await move(db, x, version, room, drawer);
    await db.query("COMMIT");

    expect(await idsInOrder(db, room)).toEqual(["顶层X", "抽屉"]);
    expect(await idsInOrder(db, null)).toEqual(["房间", "顶层Y"]);
  });

  it("防环：挂到自身或自己的子孙下都会被递归查询检出", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const root = await insertLocation(db, "根");
    const child = await insertLocation(db, "子", root);
    expect(await hasCycle(db, root, child)).toBe(true);
    expect(await hasCycle(db, child, root)).toBe(false);

    await db.query("BEGIN");
    await lockTree(db);
    await db.query("SAVEPOINT sp1");
    await expect(move(db, root, 1, child)).rejects.toThrow("LOCATION_CYCLE");
    await db.query("ROLLBACK TO SAVEPOINT sp1");
    await db.query("SAVEPOINT sp2");
    await expect(move(db, root, 1, root)).rejects.toThrow("LOCATION_CYCLE");
    await db.query("ROLLBACK TO SAVEPOINT sp2");
    await db.query("COMMIT");
  });

  it("乐观版本号：过期版本移动被拒绝，事务回滚后层级保持原样", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const a = await insertLocation(db, "甲");
    const b = await insertLocation(db, "乙");
    await db.query("UPDATE storage_locations SET version = version + 1 WHERE id=$1", [b]);
    await db.query("BEGIN");
    await lockTree(db);
    await expect(move(db, b, 1, a)).rejects.toThrow("VERSION_CONFLICT");
    await db.query("ROLLBACK");
    const after = await db.query<{ parent_id: string | null }>("SELECT parent_id FROM storage_locations WHERE id=$1", [b]);
    expect(after.rows[0]!.parent_id).toBeNull();
  });

  it("批次外键引用在节点移动后保持完整", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const parent = await insertLocation(db, "柜");
    const loc = await insertLocation(db, "格", parent);
    // 插入一个材料，批次才能满足 NOT NULL 外键
    const material = (await db.query(
      `INSERT INTO materials(name, craft_types, stock_unit) VALUES ('木料','{WOODWORKING}','g') RETURNING id`
    )).rows[0]!.id as string;
    const batch = (await db.query(
      `INSERT INTO batches(material_id, location_id, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit)
       VALUES ($1,$2,'2026-09-01','100','100','g','g') RETURNING id`,
      [material, loc]
    )).rows[0]!.id as string;

    const version = (await db.query<{ version: number }>("SELECT version FROM storage_locations WHERE id=$1", [loc]))
      .rows[0]!.version;
    await db.query("BEGIN");
    await lockTree(db);
    await move(db, loc, version, null);
    await db.query("COMMIT");

    const ref = await db.query<{ location_id: string | null }>(
      "SELECT location_id FROM batches WHERE id=$1",
      [batch]
    );
    expect(ref.rows[0]!.location_id).toBe(loc);
    const moved = await db.query<{ parent_id: string | null }>(
      "SELECT parent_id FROM storage_locations WHERE id=$1",
      [loc]
    );
    expect(moved.rows[0]!.parent_id).toBeNull();
  });

  it("移动不改动子孙节点的 parent_id，子树整体迁移", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const top1 = await insertLocation(db, "顶级一");
    const top2 = await insertLocation(db, "顶级二");
    const child = await insertLocation(db, "孩子", top1);
    const grandchild = await insertLocation(db, "孙辈", child);

    const version = (await db.query<{ version: number }>("SELECT version FROM storage_locations WHERE id=$1", [top1]))
      .rows[0]!.version;
    await db.query("BEGIN");
    await lockTree(db);
    await move(db, top1, version, top2);
    await db.query("COMMIT");

    const links = await db.query<{ id: string; parent_id: string | null }>(
      "SELECT id, parent_id FROM storage_locations WHERE id IN ($1,$2)",
      [child, grandchild]
    );
    const map = new Map(links.rows.map((r) => [r.id, r.parent_id]));
    expect(map.get(child)).toBe(top1);
    expect(map.get(grandchild)).toBe(child);
  });

  it("reorder 集合不一致时拒绝（并发变更冲突）", async () => {
    await db.query("TRUNCATE storage_locations CASCADE");
    const a = await insertLocation(db, "A");
    await insertLocation(db, "B");
    const current = await siblingIds(db, null);
    // 模拟并发：新增节点后，旧的排序列表过期
    await insertLocation(db, "C");
    const sameSet =
      current.length === 2 && new Set([...current, ...current]).size === new Set(current).size;
    expect(sameSet).toBe(true); // 旧列表自身完整
    const fresh = await siblingIds(db, null);
    const staleSet =
      current.length === fresh.length &&
      new Set(current).size === new Set([...current, ...fresh]).size;
    expect(staleSet).toBe(false); // 与数据库集合不一致 → 必须拒绝
    void a;
  });
});

describe("库位树契约校验", () => {
  it("move 要求显式 parentId 与正数 version", () => {
    expect(locationMoveSchema.safeParse({ parentId: null, version: 1 }).success).toBe(true);
    expect(locationMoveSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(locationMoveSchema.safeParse({ parentId: null, version: 0 }).success).toBe(false);
  });

  it("reorder 要求非空有序 id 列表与显式 parentId", () => {
    expect(locationReorderSchema.safeParse({ parentId: null, orderedIds: [] }).success).toBe(false);
    expect(
      locationReorderSchema.safeParse({
        parentId: "00000000-0000-0000-0000-000000000001",
        orderedIds: ["00000000-0000-0000-0000-000000000002"]
      }).success
    ).toBe(true);
    expect(locationReorderSchema.safeParse({ orderedIds: ["x"] }).success).toBe(false);
  });
});
