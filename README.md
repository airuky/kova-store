# KOVA Store

社内研修用の架空の EC サイトです。商品閲覧、アカウント、カート、注文、レビューなどの通常操作を備えています。一部の処理には意図的な欠陥があります。教材の説明や進行手順は画面に表示せず、[講師用資料](docs/INSTRUCTOR.md) に置いています。実際の個人情報、決済情報、外部サービスは使用しません。

**安全上の注意:** このアプリは意図的に脆弱です。実データを入力せず、インターネットや共有 LAN に公開しないでください。公開リポジトリには講師用資料とデモ用の認証情報も含まれます。

## Docker で起動

このディレクトリで実行します。Docker Engine と Docker Compose が必要です。

```sh
docker compose up --build -d --wait
```

Mac のブラウザーで [http://127.0.0.1:4327](http://127.0.0.1:4327) を開きます。デモ購入者のログインは `mio@kova.local` / `KovaDemo2026!` です。ポートを変える場合は `KOVA_PORT=4330 docker compose up --build -d --wait` のように指定します。状態は `docker compose ps`、ログは `docker compose logs -f app gateway` で確認できます。

アプリ本体は Docker の内部ネットワークに置き、ホストに公開しません。公開されるのはゲートウェイの `127.0.0.1:4327` のみです。ゲートウェイは固定の `app:3000` に転送します。

### VMware NAT の Kali から使う

Mac 側で VMware NAT インターフェースのアドレスを確認します。以前の環境の値は `192.168.180.1` ですが、VMware の設定が変わると異なります。

```sh
ifconfig bridge101
docker compose -f compose.yaml -f compose.vmware.yaml config
docker compose -f compose.yaml -f compose.vmware.yaml up --build -d --wait
```

`bridge101` の `inet` が `192.168.180.1` なら、Kali のブラウザーで [http://192.168.180.1:4327](http://192.168.180.1:4327) を開きます。Kali で `curl -i http://192.168.180.1:4327/api/health` として到達を確認できます。Kali の `127.0.0.1` は Kali 自身です。ホスト側の NAT アドレスが異なる場合は、上の2つの Docker コマンドに `KOVA_VM_HOST_IP=<実際のMac側IPv4>` を付けます。追加ファイルはプライベート IPv4 アドレスだけを許可します。LAN 側のアドレスや `0.0.0.0` は指定しないでください。

演習後に Mac のローカルホストだけへ戻すには、追加ファイルを指定せずに再作成します。

```sh
docker compose up -d --force-recreate --wait
```

## 停止と初期化

`docker compose down` はコンテナを停止し、研修データのボリュームを残します。初期状態からやり直すときは、**保存されたアカウント、注文、レビューをすべて消す** 次のコマンドを使います。

```sh
docker compose down -v
docker compose up --build -d --wait
```

VM向け構成で起動中の場合も、`docker compose down -v` で同じ Compose プロジェクトのコンテナとボリュームを停止・削除します。

## ローカル開発

Node.js 24 以上が必要です。

```sh
npm ci
npm run dev
```

開発画面は [http://127.0.0.1:5173](http://127.0.0.1:5173)、API は `127.0.0.1:3000` です。型確認と本番用ビルドは `npm run typecheck`、`npm run build`、バックエンドのテストは `npm test` で実行します。

依存パッケージの取得と Docker イメージの取得にはネットワークが必要です。実行中のサーバーは外部 API や実決済へ接続しません。架空のデータだけを入力してください。
