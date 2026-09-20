-- 库位树：排序字段、乐观锁版本
ALTER TABLE storage_locations ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE storage_locations ADD COLUMN version integer NOT NULL DEFAULT 1;

-- 现有数据按“同一上级内按名称”补排排序号
WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY parent_id
           ORDER BY name, id
         ) - 1 AS rn
    FROM storage_locations
)
UPDATE storage_locations l
   SET sort_order = o.rn
  FROM ordered o
 WHERE l.id = o.id;

CREATE INDEX locations_parent_order_idx ON storage_locations(parent_id, sort_order);
