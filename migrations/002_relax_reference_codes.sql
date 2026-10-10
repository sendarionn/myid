-- 製品コードと契約番号を、利用者が入力した表記のまま保存できるようにする
-- 英大文字・数字・ハイフン限定をやめ、大小文字・日本語・記号を許可する
-- 前後の空白と制御文字は許可しない
-- 既存データは旧制約（新制約の部分集合）を満たしているため変換しない

ALTER TABLE project_products
  DROP CONSTRAINT project_products_product_code_check,
  ADD CONSTRAINT project_products_product_code_check CHECK (
    char_length(product_code) BETWEEN 1 AND 64
    AND product_code = btrim(product_code)
    AND product_code !~ '[[:cntrl:]]'
  );

ALTER TABLE project_contracts
  DROP CONSTRAINT project_contracts_contract_reference_check,
  ADD CONSTRAINT project_contracts_contract_reference_check CHECK (
    char_length(contract_reference) BETWEEN 1 AND 64
    AND contract_reference = btrim(contract_reference)
    AND contract_reference !~ '[[:cntrl:]]'
  );
