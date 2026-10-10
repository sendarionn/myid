# myid

My Identity Directory

匿名Passkey認証と案件単位の権限管理を検証するPoC

- 現在はPoC段階で、本番運用は想定していない
- 本番公開前に必要な対策は [SECURITY.md](SECURITY.md) の「本番公開前の要件」を参照

## 概要と設計思想

従来のCRMは氏名・メールアドレス・電話番号・所属企業などの顧客属性を中心に作られる
myidは匿名の個人IDと案件IDを中心に設計し、必要な情報を必要な主体だけが持つ業務基盤を目指す

- 取得しない
  - 氏名・メールアドレス・電話番号・所属組織を登録に使わない
  - IPアドレス・User-Agentも保存しない
- 所属から推定しない
  - 組織や従業員名簿を管理せず、案件への参加関係と明示的な権限だけを情報開示の根拠にする
  - 案件の参加者と権限は、案件の管理者（顧客自身）が管理する
- 結合させない
  - 他の参加者や履歴にはユーザーIDを見せず、案件ごとに異なる参加関係IDだけを使う
- 侵害を前提にする
  - 整合性の規則をDBでも強制し、アプリ用DBロールはDMLに限定する

## 現在実装されている機能

- 匿名アカウント
  - Passkeyだけで登録・ログイン・ログアウトできる
  - 同一端末で複数のアカウントを作成し、OS・ブラウザの選択画面で切り替えられる
  - Passkeyの追加・一覧・削除（最後の1件は削除不可）
  - Passkey追加・削除とアカウント削除の前に、直近の再認証を要求する
  - アカウント削除（共有案件は残る）
- 案件
  - 作成・編集・一覧・検索
  - 作成者が初期管理者になる（PoC仕様）
  - 案件情報は閲覧範囲ごとに分かれる
    - 基本情報（案件名・状態）
    - 製品・作業予定
    - 契約（ダミー）
  - 製品コード・契約番号は大文字・小文字・日本語・記号を含めて、入力した表記のまま保存・表示する
    - 前後の空白は除き、制御文字と65文字以上は受け付けない
    - イベント履歴
- 招待と参加者管理
  - 役割・権限・有効期限（最大7日）を指定した招待リンクの発行
  - 招待の取消、一回限りの使用、承認制の招待
  - 参加者の権限変更・承認・失効・退出
  - 権限変更と招待の監査ログ
- 確認用のWeb画面（ビルドなしのES Module）

### 実装していないもの

- アカウント復旧（すべてのPasskeyを失うと復旧できない）
- 実際の契約・決済、配送・施工手配、顧客住所の管理
- Chatwootなど外部サービスとの連携
- レート制限、運営者権限、監視
- 注文・契約に基づく案件管理者の正当性確認

## 技術スタック

| 用途 | 採用 |
| --- | --- |
| 実行環境 | Node.js 24.2以上（TypeScriptを型除去で直接実行、ビルドなし） |
| Webフレームワーク | Express 5 |
| WebAuthn | `@simplewebauthn/server` / `@simplewebauthn/browser` 14 |
| セッション | `express-session` + `connect-pg-simple`（サーバー側セッション） |
| DB | PostgreSQL（`pg`） |
| テスト | `node:test`、テスト用ソフトウェア認証器 |
| 開発・テスト用DB | `embedded-postgres` |
| 型検査 | TypeScript（`tsc --noEmit`） |
| 本番相当構成 | Dockerfile、Docker Compose（起動は未確認） |

## 開発環境のセットアップ

- Node.js 24.2以上（`.nvmrc` は24）
- macOS（arm64）では追加のソフトウェアは不要
  - 開発・テスト用のPostgreSQLは `embedded-postgres` が起動する
  - 他のOSでは `embedded-postgres` の対応状況を確認するか、既存のPostgreSQLを使う
- 秘密情報の検出（`npm run secrets`）には `gitleaks` が必要

```sh
npm ci
```

`embedded-postgres` のpostinstallスクリプト（symlinkの復元）は `package.json` の `allowScripts` で許可している

## 起動

```sh
npm run dev
```

- `http://localhost:3000` で起動する
- 初回は `.local/pgdata` にPostgreSQLを作成し、マイグレーションを適用する
- アプリとPostgreSQLは `127.0.0.1` のみで待ち受ける
- `SESSION_SECRET` を指定しない場合は起動ごとに生成し、再起動すると全セッションが無効になる
- `Ctrl+C` でアプリとPostgreSQLを停止する

既存のPostgreSQLを使う場合

```sh
DATABASE_URL=postgres://... npm run migrate
DATABASE_URL=postgres://... ORIGIN=http://localhost:3000 SESSION_SECRET=$(openssl rand -base64 32) npm start
```

| 環境変数 | 内容 |
| --- | --- |
| `DATABASE_URL` | 接続先（必須） |
| `ORIGIN` | ブラウザがアクセスするOrigin（必須）。WebAuthnのOrigin検証とCSRF検査に使う |
| `RP_ID` | WebAuthnのRP ID。省略時は `ORIGIN` のホスト名 |
| `RP_NAME` | WebAuthnのRP名。省略時は `myid` |
| `SESSION_SECRET` | Cookie署名用の秘密（32文字以上、必須） |
| `COOKIE_SECURE` | `true` でSecure属性と `__Host-` 接頭辞を付ける。https の `ORIGIN` では既定で `true` |
| `TRUST_PROXY` | TLS終端するリバースプロキシの背後で `true` |
| `HOST` / `PORT` | 待ち受けアドレス（既定 `127.0.0.1:3000`） |

`NODE_ENV=production` では https の `ORIGIN` とSecure Cookieを必須にする

### Docker Compose

```sh
cp .env.example .env   # 値を設定する
docker compose up --build
```

- DBはポートを公開せず、内部ネットワークだけで接続する
- マイグレーションは所有者ロール、アプリはDML権限のみのロールで接続する
- この構成はDockerのない環境で作成したため、`docker compose` での起動は未確認
  - ロール分離のSQLとアプリの動作は、ローカルのPostgreSQLで確認済み

## 操作方法

ブラウザで `http://localhost:3000` を開く
`localhost` はhttpでもWebAuthnを利用できる

1. アカウント作成
   - 「識別名」に任意の名前を入れて「新規アカウント作成」を押す
   - 識別名はOS・ブラウザのPasskey一覧で区別するためだけに使われ、サーバーには送られない
   - Passkeyの作成が完了するとログイン状態になる
2. 同じ端末で別のアカウントを作る
   - 「ログアウト」後、もう一度「新規アカウント作成」を押す
   - 「Passkeyでログイン」を押すと、OS・ブラウザの選択画面に両方のアカウントが表示される
3. 案件の作成
   - 「案件」で案件名を入れて「作成」を押す
   - 作成者には全権限（参加者管理を含む）が付与される
4. 参加者の招待
   - 案件画面の「招待」で役割・権限・有効期限を選び「招待リンクを発行」を押す
   - 表示されたリンクは一度しか表示されないため、コピーして相手に渡す
   - 「参加に承認を要求」を選ぶと、受諾後に管理者が「承認」するまで閲覧できない
5. 招待の受諾
   - 別ブラウザ（または別アカウントでログインし直した状態）でリンクを開く
   - 未ログインならログインまたはアカウント作成を求められ、その後「受諾」を押す
   - 1つの招待リンクで参加できるのは1人だけ
6. 権限の変更・失効
   - 案件画面の「参加者」で権限のチェックを変えて「更新」、または「失効」を押す
   - 失効した参加者は次のリクエストから案件にアクセスできない
   - 管理者が0人になる変更は拒否される
7. Passkeyの追加・削除
   - 「アカウント」で「Passkeyを追加」を押す（直近5分以内にログインしていなければ再認証を求められる）
   - 同じ認証器には同じアカウントのPasskeyを重複登録できないため、別の端末やセキュリティキーで追加する
   - 最後の1件は削除できない
8. アカウント削除
   - 「アカウント」で削除対象の案件数を確認して「アカウントを削除」を押す
   - 他の参加者がいる案件の唯一の管理者である場合は、先に管理権限を移譲するまで削除できない
   - 自分しか参加していない案件はアカウントと一緒に削除され、共有案件は残る

## テスト

```sh
npm test            # 一時PostgreSQLを起動して全テストを実行
npm run typecheck   # 型検査
npm run audit       # 依存関係の脆弱性監査
npm run secrets     # gitleaksによる秘密情報の検出
npm run check       # 上記すべて
```

- テストファイルごとにマイグレーション済みのテンプレートDBを複製するため、テスト同士は干渉しない
- 既存のPostgreSQLを使う場合は `TEST_PG_ADMIN_URL`（DB作成権限のある接続先）を指定する
- GitHub Actions（`.github/workflows/ci.yml`）でも、push・Pull Requestごとに型検査・テスト・依存関係監査・gitleaksを実行する
  - CIではPostgreSQLのサービスコンテナを使い、`embedded-postgres` は使わない
- WebAuthnはテスト用のソフトウェア認証器（`test/authenticator.ts`）で検証する
  - OS・ブラウザのPasskey UI、同期Passkey、実機の認証器の挙動はテストの対象外
  - 実機で確認すべき項目は [SECURITY.md](SECURITY.md) の「実機確認が必要な項目」

## セキュリティ上の注意点

- PoCのため、次の対策がない
  - レート制限（匿名で大量の登録・Challenge発行・セッション作成ができる）
  - アカウント復旧手段
  - 運営者権限と不正利用対応
  - DB・バックアップの暗号化
- 本番公開にはTLS、`NODE_ENV=production`、`COOKIE_SECURE=true`、`TRUST_PROXY=true` が必要
- 実在する顧客情報・契約情報をテストや動作確認に使わない
- `.env`、`.local/` はGit管理外（`.local/` には開発用DBのパスワードが保存される）
- 招待リンクには招待トークンが含まれるため、ログやチャットツールの公開チャンネルに貼らない
- このリポジトリは公開されている
  - 秘密情報・実データ・ログ・DBダンプをコミットしない
  - コミットの作者名・メールアドレスも公開される
- 脅威モデルと残存リスクは [SECURITY.md](SECURITY.md) を参照

## 今後の開発方針

将来構想であり、いずれも未実装

- Phase 2: 案件に紐付く注文・契約、契約主体の管理、案件管理者の正当性確認、データ保持・削除ポリシー
- Phase 3: Chatwootによる問い合わせ対応（会話原文は複製せず、共有すべき事実だけを案件へ反映）
- Phase 4: 配送・施工業者への直接情報連携（住所などを自社サーバーに通さない）
- Phase 5: 案件イベントの集計・分析（個人情報の長期蓄積を前提にしない）

設計上の方針は [ARCHITECTURE.md](ARCHITECTURE.md) の「将来の拡張方針」を参照

## ライセンス

未定（LICENSEファイルなし）

- ライセンスが付くまでは、GitHub利用規約で認められる範囲（閲覧・フォーク）を除き、複製・改変・再配布は許諾されていない
- 依存パッケージはMIT・Apache-2.0・BSD・ISC・0BSDで、いずれも再配布時は著作権表示とライセンス文の同梱が必要

## 貢献・脆弱性の報告

- 不具合・提案はIssueで受け付ける
- 脆弱性はIssueに書かず、[SECURITY.md](SECURITY.md) の「脆弱性の報告」の手順で非公開に報告する
- Pull Requestでは [AGENTS.md](AGENTS.md) の開発ルール（否定系テスト、ドキュメント・HISTORYの更新など）に従う

## 関連ドキュメント

| ファイル | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | システム構成、ER図、認証・認可フロー、信頼境界 |
| [SECURITY.md](SECURITY.md) | 設計原則、脅威モデル、残存リスク、本番公開前の要件 |
| [HISTORY.md](HISTORY.md) | 変更履歴、設計判断の理由、未解決事項 |
| [AGENTS.md](AGENTS.md) | 開発エージェント向けの作業ルール |
