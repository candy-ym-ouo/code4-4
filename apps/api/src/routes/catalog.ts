import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  sourceInputSchema,
  locationInputSchema,
  locationMoveSchema,
  locationPatchSchema,
  locationReorderSchema
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { parsePagination, pageMeta } from "../lib/pagination.js";
import { writeAudit } from "../lib/audit.js";
import {
  assertCanCreate,
  assertCanRename,
  loadLocationForUpdate,
  lockLocationTree,
  moveLocation,
  nextSortOrder,
  reorderLocations
} from "../lib/locationTree.js";

type Query = Record<string, string | undefined>;

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/sources", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = [request.query.archived === "true" ? "s.archived_at IS NOT NULL" : "s.archived_at IS NULL"];
    if (request.query.q) {
      values.push(`%${request.query.q.trim()}%`);
      conditions.push(`(s.name ILIKE $${values.length} OR s.contact_name ILIKE $${values.length})`);
    }
    if (request.query.type) {
      values.push(request.query.type);
      conditions.push(`s.type = $${values.length}::source_type`);
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM sources s WHERE ${where}`, values);
    values.push(pageSize, offset);
    const result = await pool.query(
      `SELECT s.id, s.name, s.type, s.contact_name AS "contactName", s.contact_phone AS "contactPhone",
              s.contact_email AS "contactEmail", s.address, s.notes, s.archived_at AS "archivedAt",
              s.created_at AS "createdAt", s.updated_at AS "updatedAt",
              count(b.id)::int AS "batchCount",
              count(b.id) FILTER (WHERE b.status <> 'ARCHIVED' AND b.remaining_quantity > 0)::int AS "activeBatchCount"
         FROM sources s LEFT JOIN batches b ON b.source_id = s.id
        WHERE ${where}
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: result.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/sources/:id", async (request) => {
    const result = await pool.query(
      `SELECT id, name, type, contact_name AS "contactName", contact_phone AS "contactPhone",
              contact_email AS "contactEmail", address, notes, archived_at AS "archivedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM sources WHERE id = $1`,
      [request.params.id]
    );
    const source = result.rows[0];
    if (!source) throw new AppError(404, "NOT_FOUND", "来源不存在");
    const batches = await pool.query(
      `SELECT b.id, b.batch_code AS "batchCode", b.remaining_quantity::text AS "remainingQuantity",
              b.stock_unit AS "stockUnit", b.status, b.received_at AS "receivedAt",
              m.id AS "materialId", m.name AS "materialName"
         FROM batches b JOIN materials m ON m.id = b.material_id
        WHERE b.source_id = $1 ORDER BY b.created_at DESC`,
      [request.params.id]
    );
    return { data: { ...source, batches: batches.rows } };
  });

  app.post("/sources", async (request, reply) => {
    const input = parseInput(sourceInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO sources(name, type, contact_name, contact_phone, contact_email, address, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, type, contact_name AS "contactName", contact_phone AS "contactPhone",
                   contact_email AS "contactEmail", address, notes, archived_at AS "archivedAt",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [input.name, input.type, input.contactName || null, input.contactPhone || null, input.contactEmail || null, input.address || null, input.notes || null]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "SOURCE", entityId: result.rows[0]?.id,
        afterData: result.rows[0], requestId: request.id
      });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/sources/:id", async (request) => {
    const input = parseInput(sourceInputSchema.partial(), request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM sources WHERE id = $1 FOR UPDATE", [request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "来源不存在");
      const result = await client.query(
        `UPDATE sources SET
          name = coalesce($1, name), type = coalesce($2::source_type, type),
          contact_name = CASE WHEN $3::boolean THEN $4 ELSE contact_name END,
          contact_phone = CASE WHEN $5::boolean THEN $6 ELSE contact_phone END,
          contact_email = CASE WHEN $7::boolean THEN $8 ELSE contact_email END,
          address = CASE WHEN $9::boolean THEN $10 ELSE address END,
          notes = CASE WHEN $11::boolean THEN $12 ELSE notes END
         WHERE id = $13 RETURNING *`,
        [
          input.name ?? null, input.type ?? null,
          "contactName" in input, input.contactName || null,
          "contactPhone" in input, input.contactPhone || null,
          "contactEmail" in input, input.contactEmail || null,
          "address" in input, input.address || null,
          "notes" in input, input.notes || null,
          request.params.id
        ]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "SOURCE", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/sources/:id/archive", async (request) => archiveSource(request.params.id, true, request));
  app.post<{ Params: { id: string } }>("/sources/:id/unarchive", async (request) => archiveSource(request.params.id, false, request));

  async function archiveSource(id: string, archived: boolean, request: FastifyRequest) {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const result = await client.query(
        "UPDATE sources SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 RETURNING *",
        [archived, id]
      );
      if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "来源不存在");
      await writeAudit(client, { actorUserId: user.id, action: archived ? "ARCHIVE" : "UNARCHIVE", entityType: "SOURCE", entityId: id, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  }

  app.get<{ Querystring: Query }>("/locations", async (request) => {
    const includeArchived = request.query.archived === "true";
    const result = await pool.query(
      `SELECT l.id, l.name, l.parent_id AS "parentId", l.notes, l.archived_at AS "archivedAt",
              l.sort_order AS "sortOrder", l.version,
              l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              count(b.id)::int AS "batchCount"
         FROM storage_locations l
         LEFT JOIN batches b ON b.location_id = l.id AND b.status <> 'ARCHIVED'
        WHERE ${includeArchived ? "l.archived_at IS NOT NULL" : "l.archived_at IS NULL"}
        GROUP BY l.id
        ORDER BY l.parent_id NULLS FIRST, l.sort_order, l.name`
    );
    return { data: result.rows };
  });

  app.post("/locations", async (request, reply) => {
    const input = parseInput(locationInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      // 串行化结构变更，防止并发创建/移动造成的层级竞态
      await lockLocationTree(client);
      await assertCanCreate(client, input.parentId || null, input.name);
      const sortOrder = await nextSortOrder(client, input.parentId || null);
      const result = await client.query(
        `INSERT INTO storage_locations(name, parent_id, notes, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, parent_id AS "parentId", notes, sort_order AS "sortOrder",
                   version, archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [input.name, input.parentId || null, input.notes || null, sortOrder]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "LOCATION", entityId: result.rows[0]?.id,
        afterData: result.rows[0], requestId: request.id
      });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  // 仅改名称/备注；层级调整走 /move，避免普通编辑里混入环风险
  app.patch<{ Params: { id: string } }>("/locations/:id", async (request) => {
    const input = parseInput(locationPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const old = await loadLocationForUpdate(client, request.params.id);
      if (old.archived_at) throw new AppError(422, "LOCATION_ARCHIVED", "位置已归档，不能编辑");
      const nextName = input.name ?? old.name;
      await assertCanRename(client, old, nextName);
      const result = await client.query(
        `UPDATE storage_locations SET
          name = $2,
          notes = CASE WHEN $3::boolean THEN $4 ELSE notes END,
          version = version + 1
         WHERE id = $1
         RETURNING id, name, parent_id AS "parentId", notes, sort_order AS "sortOrder",
                   version, archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          request.params.id,
          nextName,
          "notes" in input,
          input.notes || null
        ]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "LOCATION", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  // 库位树移动：在单事务内改 parent_id、压实新旧同级序号，失败整体回滚不留断链
  app.post<{ Params: { id: string } }>("/locations/:id/move", async (request, reply) => {
    const input = parseInput(locationMoveSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const data = await withTransaction(async (client) => {
      await lockLocationTree(client);
      const before = await loadLocationForUpdate(client, request.params.id);
      const { row, moved } = await moveLocation(
        client,
        request.params.id,
        input.version,
        input.parentId,
        input.beforeId ?? null
      );
      if (moved) {
        await writeAudit(client, {
          actorUserId: user.id, action: "MOVE", entityType: "LOCATION", entityId: request.params.id,
          beforeData: { parentId: before.parent_id, sortOrder: before.sort_order, version: before.version },
          afterData: { parentId: row.parent_id, sortOrder: row.sort_order, version: row.version },
          requestId: request.id
        });
      }
      return row;
    });
    return reply.status(200).send({ data: serializeLocation(data) });
  });

  // 同一父级下的纯排序（不移动父子关系）
  app.post("/locations/reorder", async (request) => {
    const input = parseInput(locationReorderSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    await withTransaction(async (client) => {
      await lockLocationTree(client);
      const orderedIds = await reorderLocations(client, input.parentId, input.orderedIds);
      await writeAudit(client, {
        actorUserId: user.id, action: "REORDER", entityType: "LOCATION",
        entityId: input.parentId, afterData: { parentId: input.parentId, orderedIds }, requestId: request.id
      });
    });
    return { data: { parentId: input.parentId, orderedIds: input.orderedIds } };
  });

  app.post<{ Params: { id: string } }>("/locations/:id/archive", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      await lockLocationTree(client);
      await loadLocationForUpdate(client, request.params.id);
      const children = await client.query(
        "SELECT 1 FROM storage_locations WHERE parent_id = $1 AND archived_at IS NULL LIMIT 1",
        [request.params.id]
      );
      if (children.rowCount) throw new AppError(409, "LOCATION_HAS_CHILDREN", "请先归档或移走该位置下的子位置");
      const result = await client.query(
        "UPDATE storage_locations SET archived_at = now(), version = version + 1 WHERE id = $1 RETURNING *",
        [request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "ARCHIVE", entityType: "LOCATION", entityId: request.params.id, afterData: result.rows[0], requestId: request.id });
      return { data: serializeLocation(result.rows[0]) };
    });
  });
}

function serializeLocation(row: Record<string, unknown> & {
  id: string;
  name: string;
  parent_id?: string | null;
  parentId?: string | null;
  notes: string | null;
  sort_order?: number;
  sortOrder?: number;
  version: number;
  archived_at?: Date | null;
  archivedAt?: Date | null;
  created_at?: Date;
  createdAt?: Date;
  updated_at?: Date;
  updatedAt?: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId ?? row.parent_id ?? null,
    notes: row.notes,
    sortOrder: row.sortOrder ?? row.sort_order ?? 0,
    version: row.version,
    archivedAt: row.archivedAt ?? row.archived_at ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null
  };
}
