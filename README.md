# myid

匿名Passkey認証と案件単位の権限管理を検証するPoC

- メールアドレス・電話番号・氏名・所属組織を取得せずに登録できる
- 案件ごとに参加者と権限を管理し、明示的に付与された権限だけで情報を開示する
- 設計は [ARCHITECTURE.md](ARCHITECTURE.md)、脅威モデルと残存リスクは [SECURITY.md](SECURITY.md)、設計判断の経緯は [HISTORY.md](HISTORY.md)

## 必要なもの

- Node.js 24.2以上（`.nvmrc` は24）
  - TypeScriptはNode標準の型除去で直接実行するため、ビルドは不要
- macOS（arm64）では追加のソフトウェアは不要
  - 開発・テスト用のPostgreSQLは `embedded-postgres` が起動する
  - 他のOSでは `embedded-postgres` の対応状況を確認するか、既存のPostgreSQLを使う

## 起動

```sh
npm ci
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

## テスト

```sh
npm test            # 一時PostgreSQLを起動して全テストを実行
npm run typecheck   # 型検査
npm run audit       # 依存関係の脆弱性監査
npm run secrets     # gitleaksによる秘密情報の検出（gitleaksが必要）
npm run check       # 上記すべて
```

- テストごとにマイグレーション済みのテンプレートDBを複製するため、テスト同士は干渉しない
- 既存のPostgreSQLを使う場合は `TEST_PG_ADMIN_URL`（DB作成権限のある接続先）を指定する
- WebAuthnはテスト用のソフトウェア認証器（`test/authenticator.ts`）で検証する
  - OS・ブラウザのPasskey UI、同期Passkey、実機の認証器の挙動はテストの対象外

## 操作手順

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

すべてのPasskeyを失うとアカウントは復旧できない
