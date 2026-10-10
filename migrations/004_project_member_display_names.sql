-- 案件ごとの表示名と、未設定時の安定した仮表示用番号

ALTER TABLE project_memberships
  ADD COLUMN display_name text,
  ADD COLUMN display_number integer;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n
  FROM project_memberships
)
UPDATE project_memberships m
SET display_number = numbered.n
FROM numbered
WHERE numbered.id = m.id;

-- UPDATEで発生した遅延制約トリガーを、同じテーブルのALTER前に実行する
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE project_memberships
  ALTER COLUMN display_number SET NOT NULL,
  ADD CONSTRAINT project_memberships_display_number_positive CHECK (display_number > 0),
  ADD CONSTRAINT project_memberships_display_number_unique UNIQUE (project_id, display_number),
  ADD CONSTRAINT project_memberships_display_name_valid CHECK (
    display_name IS NULL OR (
      char_length(display_name) BETWEEN 1 AND 100
      AND display_name = btrim(display_name)
      AND display_name !~ '[[:cntrl:]]'
    )
  );
